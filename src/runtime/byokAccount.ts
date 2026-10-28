import { join } from "node:path";
import { InMemoryCredentialStore, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PrivateRecord } from "../privateRecord.ts";
import {
  BYOK_PROVIDER,
  MODEL_API_MAX_CONNECTIONS,
  byokModelReference,
  isByokProvider,
  parseByokConnection,
  parseByokProvider,
  parseByokRecords,
  type ByokSetupInput,
  type ByokSetupRecord,
  type ByokFailureCode,
} from "./byok.ts";
import { OPENAI_CODEX_PROVIDER, type RuntimeAccountState, type RuntimeAccountSummary } from "./protocol.ts";

/** Owns the closed provider declaration; Pi alone owns credential persistence. */
export class ByokAccount {
  readonly #record: PrivateRecord<readonly ByokSetupRecord[]>;
  constructor(private readonly runtime: ModelRuntime, directory: string) {
    this.#record = new PrivateRecord(join(directory, "byok.json"), parseByokRecords, () => new Error("Invalid private model API configuration"), 32_768);
  }

  async restore(): Promise<void> {
    const records = this.#record.read() ?? [];
    for (const setup of records) await registerByokProvider(this.runtime, setup.provider, setup);
    const credentials = await this.runtime.listCredentials();
    const configured = new Set(records.map((entry) => entry.provider));
    if (credentials.some((entry) => isByokProvider(entry.providerId) && !configured.has(entry.providerId))) {
      throw new Error("Model API credential has no provider configuration");
    }
  }

  async read(): Promise<RuntimeAccountState> {
    const oauth = await this.runtime.checkAuth(OPENAI_CODEX_PROVIDER);
    if (oauth && oauth.type !== "oauth") throw new Error("Invalid ChatGPT credential type");
    const connections: RuntimeAccountSummary[] = [];
    if (oauth?.type === "oauth") connections.push({ provider: OPENAI_CODEX_PROVIDER, authType: "oauth", subscription: true });
    for (const setup of this.#record.read() ?? []) {
      const credential = await this.runtime.checkAuth(setup.provider);
      if (credential && credential.type !== "api_key") throw new Error("Invalid model API credential type");
      if (credential?.type === "api_key") {
        connections.push({ provider: setup.provider, authType: "api_key", subscription: false, label: setup.label, model: byokModelReference(setup.provider, setup.model) });
      }
    }
    if (connections.length > 0) return { status: "signedIn", account: connections[0]!, connections };
    return { status: "signedOut" };
  }

  /** Returns only the saved declarations; credentials never cross this boundary. */
  readSetups(): readonly ByokSetupRecord[] {
    return [...(this.#record.read() ?? [])];
  }

  async configure(value: unknown, signal: AbortSignal): Promise<void> {
    const { apiKey, ...setup } = parseByokConnection(value);
    const records = [...(this.#record.read() ?? [])];
    const requestedProvider = setup.connectionId;
    const legacyCredential = records.length === 1 && records[0]!.provider === BYOK_PROVIDER
      ? await this.runtime.checkAuth(BYOK_PROVIDER)
      : undefined;
    const duplicateLegacy = !requestedProvider && legacyCredential && records.length === 1 && records[0]!.provider === BYOK_PROVIDER
      && records[0]!.baseUrl === setup.baseUrl && records[0]!.model === setup.model && records[0]!.label === setup.label;
    if (duplicateLegacy) throw new Error("Disconnect the existing model API connection first");
    const provider = requestedProvider ?? (records.length === 0 || (records.length === 1 && !legacyCredential)
      ? (records[0]?.provider ?? BYOK_PROVIDER)
      : `mochi-byok-${crypto.randomUUID().replaceAll("-", "")}`);
    if (requestedProvider && !records.some((entry) => entry.provider === requestedProvider)) throw new Error("Model API connection does not exist");
    if (!requestedProvider && records.length >= MODEL_API_MAX_CONNECTIONS) throw new Error("Too many model API connections");
    const declaration: ByokSetupRecord = { provider: parseByokProvider(provider), baseUrl: setup.baseUrl, model: setup.model, label: setup.label };
    // Validate with the same Pi transport, using only an in-memory credential.
    // No permanent Session, user context or account file is involved.
    await validateByokConnection(declaration, apiKey, signal);
    signal.throwIfAborted();
    const current = await this.runtime.checkAuth(provider);
    if (current && current.type !== "api_key") throw new Error("Invalid model API credential type");
    if (current) await this.runtime.logout(provider);
    // Metadata precedes the credential commit. An interruption before Pi saves
    // the key leaves a signed-out declaration that can be safely configured again.
    const next = records.filter((entry) => entry.provider !== provider);
    next.push(declaration);
    this.#record.write(next);
    await registerByokProvider(this.runtime, provider, declaration);
    await this.runtime.login(provider, "api_key", {
      signal,
      prompt: async (prompt) => {
        if (prompt.type !== "secret") throw new Error("Unexpected API key prompt");
        return apiKey;
      },
      notify: () => undefined,
    });
    if ((await this.read()).status !== "signedIn") throw new Error("Model API credential was not committed");
  }

  async remove(connectionId?: string): Promise<void> {
    const records = [...(this.#record.read() ?? [])];
    const provider = connectionId ?? (records.length === 1 ? records[0]!.provider : undefined);
    if (!provider) throw new Error("Choose a model API connection to remove");
    if (!records.some((entry) => entry.provider === provider)) throw new Error("Model API connection does not exist");
    // Never clear metadata before credential deletion succeeds.
    const current = await this.runtime.checkAuth(provider);
    if (!current) {
      this.#record.write(records.filter((entry) => entry.provider !== provider));
      this.runtime.unregisterProvider(provider);
      return;
    }
    if (current.type !== "api_key") throw new Error("Invalid model API credential type");
    await this.runtime.logout(provider);
    const next = records.filter((entry) => entry.provider !== provider);
    if (next.length) this.#record.write(next); else this.#record.clear();
    this.runtime.unregisterProvider(provider);
  }
}

export async function registerByokProvider(runtime: ModelRuntime, setup: ByokSetupInput): Promise<Model<Api>>;
export async function registerByokProvider(runtime: ModelRuntime, provider: string, setup: ByokSetupInput): Promise<Model<Api>>;
export async function registerByokProvider(runtime: ModelRuntime, providerOrSetup: string | ByokSetupInput, maybeSetup?: ByokSetupInput): Promise<Model<Api>> {
  const provider = typeof providerOrSetup === "string" ? providerOrSetup : BYOK_PROVIDER;
  const setup = typeof providerOrSetup === "string" ? maybeSetup! : providerOrSetup;
  const source = runtime.getModel("openai", setup.model);
  if (!source || source.api !== "openai-responses" || !source.input.includes("image")) {
    throw Object.assign(new Error("Choose an image-capable Responses model supported by Pi"), { code: "byok_model_unsupported" });
  }
  runtime.registerProvider(provider, {
    name: setup.label, baseUrl: setup.baseUrl, api: "openai-responses", authHeader: true,
    models: [{
      id: source.id, name: source.name, reasoning: source.reasoning, input: [...source.input],
      contextWindow: source.contextWindow, maxTokens: source.maxTokens,
      // A custom endpoint owns its pricing; upstream cost estimates do not apply.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(source.thinkingLevelMap ? { thinkingLevelMap: source.thinkingLevelMap } : {}),
    }],
  });
  const result = await runtime.refresh({ providers: [provider], allowNetwork: false });
  if (result.aborted || result.errors.size || runtime.getError()) throw new Error("BYOK provider could not be registered");
  const model = runtime.getModel(provider, source.id);
  if (!model) throw new Error("BYOK provider omitted the configured model");
  return model;
}

export async function validateByokConnection(setup: ByokSetupRecord, apiKey: string, signal: AbortSignal): Promise<void> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = await registerByokProvider(runtime, setup.provider, setup);
  await runtime.setRuntimeApiKey(setup.provider, apiKey, { signal });
  let status: number | undefined;
  let networkFailed = false;
  try {
    const levels = getSupportedThinkingLevels(model);
    const reasoning = levels.includes("off") ? "off" : levels[0]!;
    const reply = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
    }, {
      signal, ...(reasoning !== "off" ? { reasoning } : {}), maxTokens: 1_024, maxRetries: 0,
      // Observe the same Pi request, including non-2xx responses. Never inspect
      // error bodies or forward headers; they may echo credentials or prose.
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        try { const response = await fetch(input, init); status = response.status; return response; }
        catch (error) { networkFailed = true; throw error; }
      }, { preconnect: fetch.preconnect }),
    });
    if (reply.stopReason !== "stop" || !reply.content.some((item) => item.type === "text" && item.text.trim())) throw new Error("Invalid Responses result");
  } catch {
    // Provider errors can quote request content or credentials. They must never
    // reach the worker protocol, logs, status or renderer.
    const code: ByokFailureCode = signal.aborted ? "byok_timeout"
      : status === 401 || status === 403 ? "byok_auth_rejected"
      : status === 404 ? "byok_endpoint_unavailable"
      : status === 429 ? "byok_rate_limited"
      : status !== undefined && status >= 500 ? "byok_service_unavailable"
      : networkFailed ? "byok_network_unavailable"
      : "byok_connection_failed";
    throw Object.assign(new Error("The Responses connection could not be verified"), { code });
  } finally { await runtime.removeRuntimeApiKey(setup.provider); }
}
