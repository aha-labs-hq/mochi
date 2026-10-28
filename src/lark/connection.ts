import { FeishuConnectionError, type FeishuConnectionProgress, type FeishuConnectionFailure, type FeishuConnectionSnapshot } from "./connectionState.ts";
import type { LarkBrand } from "./platform.ts";
import { proveFeishuConnection, type FeishuConnectionProof } from "./connectionProof.ts";
import { FeishuConnectionStore, type FeishuConnectionRecord } from "./connectionStore.ts";
import { registerFeishuApp, FeishuRegistrationError } from "./registration.ts";
import { feishuSettingsUrl } from "./connectionLinks.ts";
import type { LarkContext } from "./process.ts";
import { log } from "../log.ts";

/** Failures that say nothing about the connection itself, only that Feishu did not answer. */
const TEMPORARY_FAILURES: ReadonlySet<FeishuConnectionFailure> = new Set(["provider_unavailable", "provider_response_invalid"]);

/** Everything a proof decides: identity, readiness, scopes and the name shown. */
function proofFacts(proof: FeishuConnectionProof): string {
  return JSON.stringify([proof.appId, proof.botOpenId, proof.brand, proof.problem, [...proof.missingScopes].sort(),
    [...proof.grantedScopes].sort(), proof.bot.name, proof.bot.avatarUrl]);
}

export interface FeishuRuntimeBinding extends LarkContext { targetAppId: string; botOpenId: string; brand: LarkBrand; grantedScopes: readonly string[]; displayName: string }
export interface FeishuConnectorBinding extends FeishuRuntimeBinding {
  status: "ready" | "unavailable";
  problem: string | null;
}

/** One process owner survives first-run -> permanent-session handoff.
 * Candidate creation never touches the active Bot. Promotion is explicit and must
 * be admitted by the caller only after accepted work has drained.
 */
export class FeishuConnection {
  #record: FeishuConnectionRecord;
  #snapshot: FeishuConnectionProgress = { active: null, candidate: null };
  #candidateProof: FeishuConnectionProof | undefined;
  #activeProof: FeishuConnectionProof | undefined;
  #activeFailure: FeishuConnectionFailure | null = null;
  /**
   * The last proof is display-only continuity. It never authorizes a runtime
   * binding; a failed refresh clears only the current proof and keeps this
   * bounded identity/scope summary so the catalog can say what was last known.
   */
  #lastActiveProof: FeishuConnectionProof | undefined;
  #registration: { controller: AbortController; completion: Promise<void>; url: Promise<string> } | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly #listeners = new Set<(snapshot: FeishuConnectionSnapshot) => void>();

  constructor(private readonly cliPath: string, private readonly store: FeishuConnectionStore,
    private readonly prove = proveFeishuConnection, private readonly register = registerFeishuApp,
    private readonly assertAvailable: (appId: string) => void = () => undefined) {
    this.#record = store.read();
    this.#snapshot = {
      active: this.#record.active ? { state: "checking", bot: null } : null,
      candidate: this.#record.candidate ? { state: "needsAction", bot: null, problem: "candidate_unverified" } : null,
    };
  }

  snapshot(): FeishuConnectionSnapshot {
    return structuredClone({ active: this.#snapshot.active ? { ...this.#snapshot.active, brand: this.#record.active!.brand } : null,
      candidate: this.#snapshot.candidate ? { ...this.#snapshot.candidate, brand: this.#record.candidate!.brand } : null });
  }
  subscribe(listener: (snapshot: FeishuConnectionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  runtimeBinding(): FeishuRuntimeBinding | undefined {
    const active = this.#record.active;
    if (!active || !this.#activeProof || this.#activeProof.problem !== null) return undefined;
    return Object.freeze({ ...this.#context(active.directoryId), targetAppId: active.appId, botOpenId: active.botOpenId, brand: active.brand, grantedScopes: this.#activeProof.grantedScopes, displayName: this.#activeProof.bot.name });
  }

  /**
   * Returns the persisted identity for connector status projection even when
   * the runtime cannot safely open the event stream. The connector receives no
   * credential and must still distinguish an unavailable connection from a
   * missing one.
   */
  connectorBinding(): FeishuConnectorBinding | undefined {
    const active = this.#record.active;
    if (!active) return undefined;
    const currentProof = this.#activeProof;
    const displayProof = currentProof ?? this.#lastActiveProof;
    const ready = this.#snapshot.active?.state === "ready" && currentProof?.problem === null;
    return Object.freeze({
      ...this.#context(active.directoryId),
      targetAppId: active.appId,
      botOpenId: active.botOpenId,
      brand: active.brand,
      grantedScopes: displayProof?.grantedScopes ?? [],
      displayName: displayProof?.bot.name ?? "飞书机器人",
      status: ready ? "ready" : "unavailable",
      problem: ready ? null : currentProof?.problem ?? this.#activeFailure ?? "provider_unavailable",
    });
  }

  /** Stable local connector key, available while the persisted active identity exists. */
  activeConnectionId(): string | undefined {
    return this.#record.active ? `feishu:${this.#record.active.appId}` : undefined;
  }

  refresh(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#registration) throw new FeishuConnectionError("registration_in_progress");
      if (this.#record.active) {
        this.#activeProof = undefined;
        this.#activeFailure = null;
        this.#snapshot.active = { state: "checking", bot: null };
        this.#publish();
        try {
          const proof = await this.prove(this.#context(this.#record.active.directoryId), this.#record.active);
          this.assertAvailable(proof.appId);
          this.#activeProof = proof;
          this.#lastActiveProof = proof;
          this.#activeFailure = proof.problem;
          this.#snapshot.active = { state: proof.problem === null ? "ready" : "unavailable", bot: proof.bot };
          log.info("feishu.connection_verified", { appId: proof.appId, problem: proof.problem });
        } catch (error) {
          this.#activeFailure = error instanceof FeishuConnectionError ? error.code : "provider_unavailable";
          this.#snapshot.active = { state: "unavailable", bot: null };
          log.warn("feishu.connection_unavailable", { appId: this.#record.active.appId,
            code: error instanceof FeishuConnectionError ? error.code : "provider_unavailable" });
        }
        this.#publish();
      }
      if (this.#record.candidate) await this.#verifyCandidate();
    });
  }

  /**
   * Re-proves the active connection without disturbing it, and says whether the
   * answer differs from what is in force. Nothing is published and the current
   * proof is kept, so a Bot that is working keeps working. A temporary provider
   * failure is no answer: a working Bot's live event stream is the stronger
   * signal, a known problem stays the one to fix, and the next recheck asks
   * again. The caller applies a real change through `refresh()` behind its own
   * admission.
   */
  recheck(): Promise<boolean> {
    return this.#serialize(async () => {
      const active = this.#record.active;
      if (this.#registration || !active) return false;
      const current = this.#activeProof ? proofFacts(this.#activeProof) : `failure:${this.#activeFailure}`;
      let next: string;
      try {
        const proof = await this.prove(this.#context(active.directoryId), active);
        this.assertAvailable(proof.appId);
        next = proofFacts(proof);
      } catch (error) {
        const code = error instanceof FeishuConnectionError ? error.code : "provider_unavailable";
        if (TEMPORARY_FAILURES.has(code)) return false;
        next = `failure:${code}`;
      }
      return next !== current;
    });
  }

  /** Checking a replacement does not stop or revalidate the working Bot. */
  refreshCandidate(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#registration) throw new FeishuConnectionError("registration_in_progress");
      await this.#verifyCandidate();
    });
  }

  /** Returns the provider's opaque URL only to the private host control response. */
  async startRegistration(): Promise<string> {
    const url = Promise.withResolvers<string>();
    let currentUrl = url.promise;
    await this.#serialize(async () => {
      // Reopening the companion resumes the same live attempt, never creates a second App.
      if (this.#registration) { currentUrl = this.#registration.url; return; }
      if (this.#record.candidate) throw new FeishuConnectionError("candidate_unverified");
      const directoryId = this.store.createDirectory();
      this.#save({ ...this.#record, candidate: { directoryId, appId: null, brand: null } });
      this.#snapshot.candidate = { state: "registering", bot: null, problem: null };
      this.#publish();
      const controller = new AbortController();
      const completion = this.register({ cliPath: this.cliPath, stageDirectory: this.store.resolveDirectory(directoryId),
        signal: controller.signal, onVerificationUrl: url.resolve }).then(async (app) => {
        this.#save({ ...this.#record, candidate: { directoryId, appId: app.appId, brand: app.brand } });
        await this.#verifyCandidate();
      }).catch((error: unknown) => {
        const failure = error instanceof FeishuRegistrationError ? new FeishuConnectionError(error.code)
          : error instanceof FeishuConnectionError ? error : new FeishuConnectionError("registration_failed");
        url.reject(failure);
        this.#snapshot.candidate = { state: "needsAction", bot: null, problem: failure.code };
        this.#publish();
      }).finally(() => { this.#registration = undefined; });
      this.#registration = { controller, completion, url: url.promise };
    });
    return currentUrl;
  }

  async cancelRegistration(): Promise<void> {
    const registration = this.#registration;
    if (!registration) return;
    registration.controller.abort();
    await registration.completion;
  }

  /** Forget a candidate only on an explicit discard. Does not delete the remote App
   * or official CLI credentials; a partial external creation cannot be rolled back.
   */
  discardCandidate(): Promise<void> {
    return this.#serialize(async () => {
      await this.cancelRegistration();
      this.#save({ ...this.#record, candidate: null });
      this.#candidateProof = undefined;
      this.#snapshot.candidate = null;
      this.#publish();
    });
  }

  activateCandidate(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#registration) throw new FeishuConnectionError("registration_in_progress");
      if (!this.#record.candidate) throw new FeishuConnectionError("candidate_required");
      // Do not trust a proof obtained before an arbitrarily long user pause.
      await this.#verifyCandidate();
      const proof = this.#candidateProof;
      if (!proof || proof.problem !== null) throw new FeishuConnectionError("candidate_unverified");
      this.assertAvailable(proof.appId);
      this.#save({ version: 2, active: { directoryId: this.#record.candidate.directoryId,
        appId: proof.appId, botOpenId: proof.botOpenId, brand: proof.brand }, candidate: null });
      this.#activeProof = proof;
      this.#lastActiveProof = proof;
      this.#activeFailure = null;
      this.#candidateProof = undefined;
      this.#snapshot = { active: { state: "ready", bot: proof.bot }, candidate: null };
      log.info("feishu.connection_activated", { appId: proof.appId });
      this.#publish();
    });
  }

  disconnect(): Promise<void> {
    return this.#serialize(async () => {
      this.#save({ ...this.#record, active: null });
      this.#activeProof = undefined;
      this.#lastActiveProof = undefined;
      this.#activeFailure = null;
      this.#snapshot.active = null;
      log.info("feishu.connection_disconnected");
      this.#publish();
    });
  }

  settingsUrl(): string {
    const candidate = this.#record.candidate;
    const appId = candidate ? candidate.appId : this.#record.active?.appId;
    if (!appId) throw new FeishuConnectionError("candidate_required");
    const proof = candidate ? this.#candidateProof : this.#activeProof;
    const brand = candidate ? candidate.brand : this.#record.active?.brand;
    if (!brand) throw new FeishuConnectionError("candidate_unverified");
    return feishuSettingsUrl(appId, proof?.missingScopes ?? [], brand);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.cancelRegistration();
    await this.#queue;
    this.#listeners.clear();
  }

  async #verifyCandidate(): Promise<void> {
    const candidate = this.#record.candidate;
    if (!candidate) throw new FeishuConnectionError("candidate_required");
    this.#candidateProof = undefined;
    this.#snapshot.candidate = { state: "checking", bot: null, problem: null };
    this.#publish();
    try {
      const proof = await this.prove(this.#context(candidate.directoryId), { ...(candidate.appId ? { appId: candidate.appId } : {}), ...(candidate.brand ? { brand: candidate.brand } : {}) });
      this.#save({ ...this.#record, candidate: { ...candidate, appId: proof.appId, brand: proof.brand } });
      this.assertAvailable(proof.appId);
      this.#candidateProof = proof;
      this.#snapshot.candidate = { state: proof.problem === null ? "ready" : "needsAction", bot: proof.bot, problem: proof.problem };
      log.info("feishu.candidate_verified", { appId: proof.appId, problem: proof.problem });
    } catch (error) {
      const code = error instanceof FeishuConnectionError ? error.code : "provider_unavailable";
      this.#snapshot.candidate = { state: "needsAction", bot: null, problem: code };
      log.warn("feishu.candidate_unavailable", { appId: candidate.appId, code });
    }
    this.#publish();
  }
  #context(directoryId: string): LarkContext { return { cliPath: this.cliPath, profile: "mochi", configDirectory: this.store.resolveDirectory(directoryId) }; }
  #save(value: FeishuConnectionRecord): void { this.store.write(value); this.#record = value; }
  #publish(): void { for (const listener of this.#listeners) listener(this.snapshot()); }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => {
      if (this.#closed) throw new FeishuConnectionError("connection_storage_unavailable");
      return operation();
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
