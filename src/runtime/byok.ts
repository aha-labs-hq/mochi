/** Credential-free vocabulary shared by the native host, Bridge and worker. */
export const BYOK_PROVIDER = "mochi-byok";
export const MODEL_API_PROVIDER_PREFIX = "mochi-byok-";
export const MODEL_API_MAX_CONNECTIONS = 16;
export const BYOK_MODEL_PREFIX = `${BYOK_PROVIDER}/`;
export const BYOK_MAXIMUM_MODEL_LENGTH = 128 - BYOK_MODEL_PREFIX.length;
export const BYOK_MAXIMUM_LABEL_LENGTH = 120;

export interface ByokSetupInput {
  baseUrl: string;
  model: string;
  label: string;
}
export interface ByokConnectionInput extends ByokSetupInput {
  apiKey: string;
  /** The provider to replace. Omitted when adding a new model API. */
  connectionId?: string;
}
/** Private metadata for one configured model API. It never contains the key. */
export interface ByokSetupRecord extends ByokSetupInput { provider: string }
export type ByokInputField = keyof ByokConnectionInput;
export class ByokInputError extends Error {
  constructor(readonly field: ByokInputField) { super(`Invalid BYOK ${field}`); }
}
export const BYOK_FAILURE_CODES = [
  "byok_connection_failed", "byok_model_unsupported", "byok_auth_rejected",
  "byok_endpoint_unavailable", "byok_rate_limited", "byok_service_unavailable",
  "byok_network_unavailable", "byok_timeout",
] as const;
export type ByokFailureCode = typeof BYOK_FAILURE_CODES[number];
export function isByokFailureCode(code: string): code is ByokFailureCode {
  return BYOK_FAILURE_CODES.some((value) => value === code);
}
export interface ByokAccountSummary {
  provider: string;
  authType: "api_key";
  subscription: false;
  label: string;
  model: string;
}

export function parseByokSetup(value: unknown): ByokSetupInput {
  if (!record(value) || Object.keys(value).sort().join(",") !== "baseUrl,label,model") throw new Error("Invalid BYOK setup");
  const baseUrl = inputLabel(value.baseUrl, 2_048, "baseUrl");
  const model = inputLabel(value.model, BYOK_MAXIMUM_MODEL_LENGTH, "model");
  const name = inputLabel(value.label, BYOK_MAXIMUM_LABEL_LENGTH, "label");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ByokInputError("baseUrl"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || url.search) throw new ByokInputError("baseUrl");
  return { baseUrl: url.href.replace(/\/+$/u, ""), model, label: name };
}

export function parseByokApiKey(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(value)) throw new ByokInputError("apiKey");
  return value;
}

export function parseByokConnection(value: unknown): ByokConnectionInput {
  if (!record(value)) throw new Error("Invalid model API connection");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "apiKey,baseUrl,label,model" && keys !== "apiKey,baseUrl,connectionId,label,model") throw new Error("Invalid model API connection");
  const setup = parseByokSetup({ baseUrl: value.baseUrl, model: value.model, label: value.label });
  const connectionId = value.connectionId === undefined ? undefined : parseByokProvider(value.connectionId);
  return { ...setup, apiKey: parseByokApiKey(value.apiKey), ...(connectionId ? { connectionId } : {}) };
}

/** Read both the old single-object declaration and the current array format. */
export function parseByokRecords(value: unknown): readonly ByokSetupRecord[] {
  if (record(value)) return [{ provider: BYOK_PROVIDER, ...parseByokSetup(value) }];
  if (!Array.isArray(value) || value.length > MODEL_API_MAX_CONNECTIONS) throw new Error("Invalid private model API configuration");
  const records = value.map((entry) => parseByokSetupRecord(entry));
  if (new Set(records.map((entry) => entry.provider)).size !== records.length) throw new Error("Duplicate private model API provider");
  return records;
}

/** Parses the credential-free declaration returned to the native host for editing. */
export function parseByokSetupRecord(value: unknown): ByokSetupRecord {
  if (!record(value) || Object.keys(value).sort().join(",") !== "baseUrl,label,model,provider") throw new Error("Invalid private model API configuration");
  return { provider: parseByokProvider(value.provider), ...parseByokSetup({ baseUrl: value.baseUrl, model: value.model, label: value.label }) };
}

export function parseByokProvider(value: unknown): string {
  if (typeof value !== "string" || !isByokProvider(value)) throw new Error("Invalid model API connection id");
  return value;
}

export function isByokProvider(value: unknown): value is string {
  return typeof value === "string" && (value === BYOK_PROVIDER || /^mochi-byok-[a-z0-9]{8,64}$/u.test(value));
}

export function byokModelReference(model: string): string;
export function byokModelReference(provider: string, model: string): string;
export function byokModelReference(providerOrModel: string, maybeModel?: string): string {
  const provider = maybeModel === undefined ? BYOK_PROVIDER : parseByokProvider(providerOrModel);
  const model = label(maybeModel === undefined ? providerOrModel : maybeModel, BYOK_MAXIMUM_MODEL_LENGTH);
  const reference = `${provider}/${model}`;
  if (reference.length > 128) throw new Error("Invalid model API model reference");
  return reference;
}

export function parseModelReference(value: string): { provider: "mochi-byok" | "openai-codex" | string; model: string } {
  const reference = label(value, 128);
  if (reference.startsWith(BYOK_MODEL_PREFIX)) {
    return { provider: BYOK_PROVIDER, model: label(reference.slice(BYOK_MODEL_PREFIX.length), BYOK_MAXIMUM_MODEL_LENGTH) };
  }
  const slash = reference.indexOf("/");
  if (slash > 0 && isByokProvider(reference.slice(0, slash))) {
    const provider = reference.slice(0, slash);
    return { provider, model: label(reference.slice(slash + 1), Math.max(1, 128 - provider.length - 1)) };
  }
  return { provider: "openai-codex", model: reference };
}

export function isByokAccountSummary(value: unknown): value is ByokAccountSummary {
  if (!record(value) || Object.keys(value).sort().join(",") !== "authType,label,model,provider,subscription"
    || !isByokProvider(value.provider) || value.authType !== "api_key" || value.subscription !== false) return false;
  try { label(value.label, BYOK_MAXIMUM_LABEL_LENGTH); return parseModelReference(value.model as string).provider === value.provider; }
  catch { return false; }
}

function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > maximum
    || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Invalid BYOK field");
  return value;
}
function inputLabel(value: unknown, maximum: number, field: ByokInputField): string {
  try { return label(value, maximum); } catch { throw new ByokInputError(field); }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
