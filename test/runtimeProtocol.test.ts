import { describe, expect, test } from "bun:test";
import { parseWorkerMessage, PI_WORKER_PROTOCOL_VERSION } from "../src/runtime/protocol.ts";

describe("Pi worker protocol", () => {
  test("accepts only the exact versioned message envelope", () => {
    expect(parseWorkerMessage({
      version: PI_WORKER_PROTOCOL_VERSION,
      type: "request",
      id: "bridge-1",
      method: "account.read",
      params: {},
    })).toMatchObject({ type: "request", method: "account.read" });
    expect(() => parseWorkerMessage({
      version: PI_WORKER_PROTOCOL_VERSION + 1,
      type: "event",
      event: "x",
      params: {},
    }))
      .toThrow("Unsupported Pi worker protocol version");
    expect(() => parseWorkerMessage({
      version: PI_WORKER_PROTOCOL_VERSION,
      type: "request",
      id: "bridge-1",
      method: "account.read",
      params: {},
      futureField: true,
    })).toThrow("unsupported or missing fields");
    expect(() => parseWorkerMessage({
      version: PI_WORKER_PROTOCOL_VERSION,
      type: "response",
      id: "x",
      ok: false,
      error: {},
    }))
      .toThrow("response.error contains unsupported or missing fields");
  });
});
