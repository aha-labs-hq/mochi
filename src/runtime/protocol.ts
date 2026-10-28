import { BYOK_PROVIDER, type ByokAccountSummary } from "./byok.ts";

export const PI_WORKER_PROTOCOL_VERSION = 11;
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export { BYOK_PROVIDER };

export interface RuntimeToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

export interface RuntimeReasoningEffortOption {
  id: string;
  description: string;
}

export interface RuntimeModelOption {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: readonly RuntimeReasoningEffortOption[];
  defaultEffort: string;
}

export type RuntimeAccountSummary =
  | {
    provider: typeof OPENAI_CODEX_PROVIDER;
    authType: "oauth";
    subscription: true;
  }
  | ByokAccountSummary;

export type RuntimeAccountState =
  | { status: "signedOut" }
  | {
    status: "signedIn";
    /** Stable primary connection for older callers; new code reads connections. */
    account: RuntimeAccountSummary;
    connections: readonly RuntimeAccountSummary[];
  };

export interface RuntimeLoginAttempt {
  loginId: string;
  authorizationUrl: string;
}

export interface RuntimeLoginCompletion {
  loginId: string;
  success: boolean;
  error?: string;
}

export interface RuntimeContextUsage {
  sessionId: string;
  turnId: string;
  usedTokens: number;
  modelContextWindow: number;
  fractionUsed: number;
}

export interface RuntimeSessionState {
  sessionId: string;
  capabilityAbi: string;
}

export interface RuntimeTurnInput {
  executionPolicy?: "scheduled";
  sourceMessageId: string;
  text: string;
  images: readonly { data: string; mimeType: string }[];
}

export interface RuntimeTurnWorkspace {
  cwd: string;
}

export type WorkerRequest = {
  version: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: string;
  params: unknown;
};

export type WorkerResponse = {
  version: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "response";
  id: string;
  ok: true;
  result: unknown;
} | {
  version: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "response";
  id: string;
  ok: false;
  error: { code: string; message: string };
};

export type WorkerEvent = {
  version: typeof PI_WORKER_PROTOCOL_VERSION;
  type: "event";
  event: string;
  params: unknown;
};

export type WorkerMessage = WorkerRequest | WorkerResponse | WorkerEvent;

export function parseWorkerMessage(value: unknown): WorkerMessage {
  const message = record(value, "worker message");
  if (message.version !== PI_WORKER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported Pi worker protocol version: ${String(message.version)}`);
  }
  if (message.type === "request") {
    exactKeys(message, ["version", "type", "id", "method", "params"], "worker request");
    return {
      version: PI_WORKER_PROTOCOL_VERSION,
      type: "request",
      id: boundedString(message.id, "request.id", 128),
      method: boundedString(message.method, "request.method", 128),
      params: message.params,
    };
  }
  if (message.type === "response") {
    const id = boundedString(message.id, "response.id", 128);
    if (message.ok === true) {
      exactKeys(message, ["version", "type", "id", "ok", "result"], "worker response");
      return { version: PI_WORKER_PROTOCOL_VERSION, type: "response", id, ok: true, result: message.result };
    }
    if (message.ok === false) {
      exactKeys(message, ["version", "type", "id", "ok", "error"], "worker response");
      const error = record(message.error, "response.error");
      exactKeys(error, ["code", "message"], "response.error");
      return {
        version: PI_WORKER_PROTOCOL_VERSION,
        type: "response",
        id,
        ok: false,
        error: {
          code: boundedString(error.code, "response.error.code", 128),
          message: boundedString(error.message, "response.error.message", 4_096),
        },
      };
    }
  }
  if (message.type === "event") {
    exactKeys(message, ["version", "type", "event", "params"], "worker event");
    return {
      version: PI_WORKER_PROTOCOL_VERSION,
      type: "event",
      event: boundedString(message.event, "event.event", 128),
      params: message.params,
    };
  }
  throw new Error("Pi worker sent an invalid protocol message");
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !(key in value))) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return value;
}
