import { parseAccountState, parseLoginCompletion, safeAuthorizationUrl, type RuntimeAccountObserver } from "./client.ts";
import { PI_RUNTIME_USER, PI_SUDO_PATH, PI_WORKER_PATH } from "./constants.ts";
import { runtimeLauncherEnvironment, runtimeWorkerCommand } from "./process.ts";
import { boundedString, exactKeys, PI_WORKER_PROTOCOL_VERSION, record } from "./protocol.ts";
import { RuntimeTransport } from "./transport.ts";
import { parseByokSetupRecord, type ByokSetupRecord } from "./byok.ts";

/** A deployment account worker has no Bot identity, policy, tools or Session. */
export class RuntimeAccountClient {
  #transport: RuntimeTransport | undefined;
  #connecting: Promise<RuntimeTransport> | undefined;
  #closed = false;

  constructor(private readonly observer: RuntimeAccountObserver, private readonly command = runtimeWorkerCommand({
    sudoPath: PI_SUDO_PATH, runtimeUser: PI_RUNTIME_USER, workerPath: PI_WORKER_PATH,
  })) {}

  async #connect(): Promise<RuntimeTransport> {
    if (this.#closed) throw new Error("Runtime account client is closed");
    if (this.#connecting) return this.#connecting;
    if (this.#transport?.isRunning) return this.#transport;
    const connecting = this.#open();
    this.#connecting = connecting;
    try { return await connecting; }
    finally { if (this.#connecting === connecting) this.#connecting = undefined; }
  }

  async #open(): Promise<RuntimeTransport> {
    const transport = new RuntimeTransport({
      command: this.command,
      environment: runtimeLauncherEnvironment(),
      onEvent: (event, value) => {
        if (transport !== this.#transport) return;
        if (event === "account.login.completed") this.observer.loginCompleted(parseLoginCompletion(value));
        else if (event === "account.updated") {
          const params = record(value, "account.updated");
          exactKeys(params, ["status"], "account.updated");
          if (params.status !== "signedIn" && params.status !== "signedOut") throw new Error("Invalid account status");
          this.observer.accountUpdated();
        } else throw new Error("Account worker emitted an unsupported event");
      },
      onRequest: async () => ({ ok: false, error: { code: "unsupported", message: "Account workers cannot call tools" } }),
      onFatal: () => {},
      onExit: () => {
        if (transport !== this.#transport) return;
        this.#transport = undefined;
        if (!this.#closed) this.observer.runtimeUnavailable?.();
      },
    });
    this.#transport = transport;
    transport.start();
    try {
      const initialized = record(await transport.request("account.initialize", {}), "account.initialize");
      exactKeys(initialized, ["protocolVersion"], "account.initialize");
      if (initialized.protocolVersion !== PI_WORKER_PROTOCOL_VERSION) throw new Error("Invalid account worker version");
      return transport;
    } catch (error) {
      await transport.stop(new Error("Account worker initialization failed"));
      throw error;
    }
  }

  async accountRead() { return parseAccountState(await (await this.#connect()).request("account.read", {})); }

  async readByok(): Promise<readonly ByokSetupRecord[]> {
    const value = record(await (await this.#connect()).request("account.byok.read", {}), "account.byok.read");
    exactKeys(value, ["connections"], "account.byok.read");
    if (!Array.isArray(value.connections) || value.connections.length > 16) throw new Error("Invalid model API connection declarations");
    return value.connections.map(parseByokSetupRecord);
  }

  async startChatGPTLogin() {
    const value = record(await (await this.#connect()).request("account.login.start", {}, 120_000), "account.login.start");
    exactKeys(value, ["loginId", "authorizationUrl"], "account.login.start");
    return { loginId: boundedString(value.loginId, "loginId", 128), authorizationUrl: safeAuthorizationUrl(value.authorizationUrl) };
  }

  async cancelChatGPTLogin(loginId: string): Promise<void> {
    await (await this.#connect()).request("account.login.cancel", { loginId });
  }

  async accountLogout(): Promise<void> { await (await this.#connect()).request("account.logout", {}); }

  async configureByok(input: { apiKey: string; baseUrl: string; label: string; model: string; connectionId?: string }): Promise<void> {
    await (await this.#connect()).request("account.byok.configure", input, 120_000);
  }

  async removeByok(connectionId?: string): Promise<void> {
    await (await this.#connect()).request("account.byok.remove", connectionId === undefined ? {} : { connectionId });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#connecting?.catch(() => undefined);
    const transport = this.#transport;
    if (!transport) return;
    await transport.request("runtime.shutdown", {}, 2_000).catch(() => undefined);
    await transport.stop(new Error("Account worker closed"));
    this.#transport = undefined;
  }
}
