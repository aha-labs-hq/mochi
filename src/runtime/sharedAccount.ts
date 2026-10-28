import { ControlRejection } from "../control/controlServer.ts";
import type { RuntimeAccountSnapshot } from "../control/statusSnapshot.ts";
import { errorFields, log } from "../log.ts";
import { RuntimeAccountClient } from "./accountClient.ts";
import type { RuntimeAccountObserver } from "./client.ts";
import { OPENAI_CODEX_PROVIDER, type RuntimeLoginCompletion } from "./protocol.ts";
import { RuntimeRequestError } from "./transport.ts";
import { isByokFailureCode } from "./byok.ts";
import type { ByokSetupRecord } from "./byok.ts";

export interface AccountParticipant {
  /** Whether this Bot's model policy runs on the given model connection. */
  usesConnection(provider: string): boolean;
  withAccountChange<T>(operation: () => Promise<T>): Promise<T>;
  pauseForAccountChange(): Promise<void>;
  /** Called while this Bot's admission gate is held for the change. */
  reconcileAccount(): Promise<void>;
  /** Called without a gate: the Bot settles only if the change reached its own connection. */
  accountChanged(previous: RuntimeAccountSnapshot): Promise<void>;
  accountUnavailable(): void;
}

/**
 * Which Bots an account operation reaches. A named connection reaches the Bots
 * whose policy uses it; `null` reaches none; `undefined` (unknown target)
 * reaches every Bot.
 */
type ChangeScope = string | null | undefined;

/**
 * One shared login; roster mutations and account changes use the same host queue.
 *
 * Login state belongs to a connection. Only the Bots whose model policy uses the
 * connection an operation changes are gated, paused and reconciled; every other
 * Bot keeps working and settles on its own afterwards.
 */
export class SharedRuntimeAccount {
  #snapshot: RuntimeAccountSnapshot = { status: "unknown" };
  #activeLoginId: string | undefined;
  #closed = false;
  readonly #client: RuntimeAccountClient;

  constructor(private readonly host: {
    serialize<T>(operation: () => Promise<T>): Promise<T>;
    participants(): readonly AccountParticipant[];
    publish(snapshot: RuntimeAccountSnapshot): void;
    acceptingChanges?: () => boolean;
  }, createClient: (observer: RuntimeAccountObserver) => RuntimeAccountClient = (observer) => new RuntimeAccountClient(observer)) {
    this.#client = createClient({
      accountUpdated: () => this.#accountUpdated(),
      loginCompleted: (completion) => this.#loginCompleted(completion),
      runtimeUnavailable: () => this.#unavailable(),
    });
  }

  snapshot(): RuntimeAccountSnapshot { return this.#snapshot; }

  async start(): Promise<void> {
    await this.#read().catch((error) => {
      this.#unavailable();
      log.error("runtime.account.unavailable", errorFields(error));
    });
  }

  async close(): Promise<void> { this.#closed = true; await this.#client.close(); }

  /**
   * Starting a browser login changes no credential, and no Bot can be using
   * ChatGPT yet, so no Bot is paused: Bots on a model API keep answering while
   * the customer authorizes, and Bots that wait for ChatGPT say so.
   */
  startChatGPTLogin(): Promise<{ authorizationUrl: string }> {
    return this.host.serialize(async () => {
      this.#assertOpen();
      if (this.#activeLoginId) throw new ControlRejection("login_must_complete");
      await this.#read();
      if (this.#snapshot.status === "signedIn" && this.#snapshot.connections.some((connection) => connection.provider === OPENAI_CODEX_PROVIDER)) {
        throw new ControlRejection("account_already_signed_in");
      }
      const previous = this.#snapshot;
      const started = await this.#startLogin();
      await this.#settle(previous);
      return started;
    });
  }

  cancelChatGPTLogin(): Promise<void> {
    return this.host.serialize(async () => {
      this.#assertOpen();
      const previous = this.#snapshot;
      if (this.#activeLoginId) await this.#client.cancelChatGPTLogin(this.#activeLoginId);
      this.#activeLoginId = undefined;
      try {
        await this.#read();
      } catch {
        this.#unavailable();
        throw new ControlRejection("account_status_unavailable");
      }
      await this.#settle(previous);
    });
  }

  logoutChatGPT(): Promise<void> { return this.#change(OPENAI_CODEX_PROVIDER, () => this.#client.accountLogout()); }

  /** A new model API reaches no running Bot; replacing one reaches the Bots that use it. */
  configureByok(input: { apiKey: string; baseUrl: string; label: string; model: string; connectionId?: string }): Promise<void> {
    return this.#change(input.connectionId ?? null, () => this.#client.configureByok(input).catch((error) => {
      if (error instanceof RuntimeRequestError && isByokFailureCode(error.code)) throw new ControlRejection(error.code);
      throw new ControlRejection("account_status_unavailable");
    }));
  }

  removeByok(connectionId?: string): Promise<void> { return this.#change(connectionId, () => this.#client.removeByok(connectionId)); }

  /** Used by the native editor only; the returned declarations contain no key. */
  readByok(): Promise<readonly ByokSetupRecord[]> {
    return this.host.serialize(async () => {
      if (this.#closed) throw new ControlRejection("account_status_unavailable");
      return this.#client.readByok();
    });
  }

  switchChatGPTAccount(): Promise<{ authorizationUrl: string }> {
    return this.#change(OPENAI_CODEX_PROVIDER, async () => {
      await this.#client.accountLogout();
      await this.#read();
      return this.#startLogin();
    });
  }

  /**
   * Publishes the pending login on its own connection. Connections that are
   * already signed in stay published and in service.
   */
  async #startLogin(): Promise<{ authorizationUrl: string }> {
    const attempt = await this.#client.startChatGPTLogin().catch((error) => {
      if (error instanceof RuntimeRequestError && error.code === "oauth_listener_busy") throw new ControlRejection("login_listener_busy");
      throw error;
    });
    this.#activeLoginId = attempt.loginId;
    const current = this.#snapshot;
    this.#publish(current.status === "signedIn"
      ? { status: "signedIn", account: current.account, connections: current.connections, pendingLogin: OPENAI_CODEX_PROVIDER }
      : { status: "signingIn" });
    return { authorizationUrl: attempt.authorizationUrl };
  }

  async #read(): Promise<void> { this.#publish(await this.#client.accountRead()); }

  #publish(snapshot: RuntimeAccountSnapshot): void {
    this.#snapshot = snapshot;
    this.host.publish(snapshot);
  }

  #assertOpen(): void {
    if (this.#closed) throw new ControlRejection("account_status_unavailable");
  }

  #unavailable(): void {
    if (this.#closed) return;
    this.#activeLoginId = undefined;
    // Stop admission without releasing workers that still own accepted work.
    this.#publish({ status: "unknown" });
    for (const app of this.host.participants()) app.accountUnavailable();
  }

  #accountUpdated(): void {
    if (this.#closed || this.host.acceptingChanges?.() === false) return;
    void this.host.serialize(async () => {
      if (this.#closed || this.#activeLoginId) return;
      const next = await this.#client.accountRead();
      if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
      const bots = this.host.participants();
      await this.#withGates(bots, async () => {
        for (const app of bots) await app.pauseForAccountChange();
        this.#publish(next);
        for (const app of bots) await app.reconcileAccount();
      });
    }).catch(() => this.#unavailable());
  }

  /** The new credential reaches only the Bots that waited for ChatGPT. */
  #loginCompleted(completion: RuntimeLoginCompletion): void {
    if (this.#closed) return;
    void this.host.serialize(async () => {
      if (this.#closed || completion.loginId !== this.#activeLoginId) return;
      const previous = this.#snapshot;
      this.#activeLoginId = undefined;
      await this.#read();
      await this.#settle(previous);
    }).catch(() => this.#unavailable());
  }

  #change<T>(scope: ChangeScope, operation: () => Promise<T>): Promise<T> {
    return this.host.serialize(async () => {
      this.#assertOpen();
      if (this.#activeLoginId) throw new ControlRejection("login_must_complete");
      const previous = this.#snapshot;
      const everyone = this.host.participants();
      const reached = scope === undefined ? everyone
        : scope === null ? [] : everyone.filter((app) => app.usesConnection(scope));
      try {
        // All gates are held before releasing even the first Bot's worker.
        return await this.#withGates(reached, async () => {
          try {
            for (const app of reached) await app.pauseForAccountChange();
            return await operation();
          } finally {
            let unavailable = false;
            if (!this.#activeLoginId) await this.#read().catch(() => {
              unavailable = true;
              this.#unavailable();
            });
            for (const app of reached) await app.reconcileAccount();
            if (unavailable) throw new ControlRejection("account_status_unavailable");
          }
        });
      } finally {
        await this.#settle(previous, reached);
      }
    });
  }

  /** Every Bot outside the change decides for itself whether its connection moved. */
  async #settle(previous: RuntimeAccountSnapshot, settled: readonly AccountParticipant[] = []): Promise<void> {
    if (this.#closed) return;
    for (const app of this.host.participants()) {
      if (!settled.includes(app)) await app.accountChanged(previous);
    }
  }

  #withGates<T>(bots: readonly AccountParticipant[], operation: () => Promise<T>): Promise<T> {
    const acquire = (index: number): Promise<T> => index === bots.length
      ? operation() : bots[index]!.withAccountChange(() => acquire(index + 1));
    return acquire(0);
  }
}
