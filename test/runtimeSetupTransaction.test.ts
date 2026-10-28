import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateVerifiedRuntimeSetup,
  type RuntimeSetupSessionClient,
} from "../src/runtime/setupTransaction.ts";
import type { RuntimeSessionState } from "../src/runtime/protocol.ts";
import { StateStore } from "../src/state.ts";

const ABI = `sha256:${"a".repeat(64)}`;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("first-run Runtime setup transaction", () => {
  test("activates only after a separate worker resumes the bootstrapped Session", async () => {
    const state = setupState();
    const events: string[] = [];
    const session = runtimeSession();
    const result = await activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: session, events, name: "bootstrap" }),
      createVerifier: () => client({ resume: session, events, name: "verifier" }),
    });

    expect(result).toEqual(session);
    expect(events).toEqual([
      "bootstrap.bootstrap",
      "bootstrap.close",
      "verifier.resume",
      "verifier.close",
    ]);
    expect(state.runtimeSession()).toMatchObject(session);
    expect(state.runtimeSetupSessionId()).toBeUndefined();
    state.close();
  });

  test("preserves the prepared candidate when independent resume disagrees", async () => {
    const state = setupState();
    const session = runtimeSession();
    await expect(activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: session, name: "bootstrap" }),
      createVerifier: () => client({
        resume: { ...session, capabilityAbi: `sha256:${"b".repeat(64)}` },
        name: "verifier",
      }),
    })).rejects.toThrow("无法独立复验");

    expect(state.runtimeSession()).toBeUndefined();
    expect(state.runtimeSetupSessionId()).toBe(session.sessionId);
    state.close();
  });

  test("does not verify or bind a bootstrap response for another candidate", async () => {
    const state = setupState();
    const events: string[] = [];
    const unexpected = { ...runtimeSession(), sessionId: "session-other" };
    await expect(activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: unexpected, events, name: "bootstrap" }),
      createVerifier: () => client({ resume: unexpected, events, name: "verifier" }),
    })).rejects.toThrow("身份不一致");

    expect(events).toEqual(["bootstrap.bootstrap", "bootstrap.close"]);
    expect(state.runtimeSession()).toBeUndefined();
    expect(state.runtimeSetupSessionId()).toBe("session-first-run");
    state.close();
  });

  test("preserves the prepared candidate when independent resume fails", async () => {
    const state = setupState();
    const events: string[] = [];
    const session = runtimeSession();
    await expect(activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: session, events, name: "bootstrap" }),
      createVerifier: () => client({ resumeError: new Error("resume failed"), events, name: "verifier" }),
    })).rejects.toThrow("resume failed");

    expect(events.at(-1)).toBe("verifier.close");
    expect(state.runtimeSession()).toBeUndefined();
    expect(state.runtimeSetupSessionId()).toBe(session.sessionId);
    state.close();
  });

  test("does not bootstrap before a durable candidate exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-setup-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    const events: string[] = [];
    await expect(activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: runtimeSession(), events, name: "bootstrap" }),
      createVerifier: () => client({ resume: runtimeSession(), events, name: "verifier" }),
    })).rejects.toThrow("尚未准备固定");

    expect(events).toEqual([]);
    state.close();
  });

  test("does not bootstrap after another Runtime identity exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-setup-"));
    directories.push(directory);
    const state = new StateStore(join(directory, "state.sqlite"));
    state.initializeRuntimeSession("session-existing", ABI);
    const events: string[] = [];
    await expect(activateVerifiedRuntimeSetup({
      state,
      bootstrapClient: client({ bootstrap: runtimeSession(), events, name: "bootstrap" }),
      createVerifier: () => client({ resume: runtimeSession(), events, name: "verifier" }),
    })).rejects.toThrow("已经完成设置");

    expect(events).toEqual([]);
    state.close();
  });
});

function setupState(): StateStore {
  const directory = mkdtempSync(join(tmpdir(), "mochi-runtime-setup-"));
  directories.push(directory);
  const state = new StateStore(join(directory, "state.sqlite"));
  state.prepareRuntimeSetupSession("session-first-run");
  return state;
}

function runtimeSession(): RuntimeSessionState {
  return { sessionId: "session-first-run", capabilityAbi: ABI };
}

function client(input: {
  bootstrap?: RuntimeSessionState;
  resume?: RuntimeSessionState;
  resumeError?: Error;
  events?: string[];
  name: string;
}): RuntimeSetupSessionClient {
  return {
    async bootstrapSession() {
      input.events?.push(`${input.name}.bootstrap`);
      if (!input.bootstrap) throw new Error("unexpected bootstrap");
      return input.bootstrap;
    },
    async resumeSession() {
      input.events?.push(`${input.name}.resume`);
      if (input.resumeError) throw input.resumeError;
      if (!input.resume) throw new Error("unexpected resume");
      return input.resume;
    },
    async close() {
      input.events?.push(`${input.name}.close`);
    },
  };
}
