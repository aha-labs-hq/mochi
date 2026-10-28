import { expect, test } from "bun:test";
import { ControlRejection } from "../src/control/controlServer.ts";
import type { RuntimeAccountSnapshot } from "../src/control/statusSnapshot.ts";
import { RuntimeAccountClient } from "../src/runtime/accountClient.ts";
import type { RuntimeAccountObserver } from "../src/runtime/client.ts";
import type { RuntimeAccountState } from "../src/runtime/protocol.ts";
import { type AccountParticipant, SharedRuntimeAccount } from "../src/runtime/sharedAccount.ts";
import { RuntimeRequestError } from "../src/runtime/transport.ts";

function fixture(participants: AccountParticipant[] = []) {
  let queue = Promise.resolve();
  const snapshots: RuntimeAccountSnapshot[] = [];
  let observer!: RuntimeAccountObserver;
  let unavailable = false;
  let loginCount = 0;
  let configurationError: Error | undefined;
  let configurationCount = 0;
  let state: RuntimeAccountState = { status: "signedOut" };
  class Client extends RuntimeAccountClient {
    override async accountRead() {
      if (unavailable) throw new Error("Account read failed");
      return state;
    }
    override async startChatGPTLogin() {
      loginCount++;
      return { loginId: "attempt", authorizationUrl: "https://auth.openai.com/authorize" };
    }
    override async cancelChatGPTLogin() { state = { status: "signedOut" }; }
    override async accountLogout() { state = { status: "signedOut" }; }
    override async configureByok() {
      configurationCount++;
      if (configurationError) throw configurationError;
    }
    override async close() {}
  }
  const account = new SharedRuntimeAccount({
    serialize<T>(operation: () => Promise<T>): Promise<T> {
      const next = queue.then(operation);
      queue = next.then(() => {}, () => {});
      return next;
    },
    participants: () => participants,
    publish: (snapshot) => snapshots.push(snapshot),
  }, (value) => { observer = value; return new Client(value); });
  return { account, snapshots, get observer() { return observer; }, get logins() { return loginCount; }, get configurations() { return configurationCount; }, failConfiguration(error: Error) { configurationError = error; }, failReads() { unavailable = true; }, signIn() { state = { status: "signedIn", account: { provider: "openai-codex", authType: "oauth", subscription: true }, connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }] }; },
    useModelApi() { state = MODEL_API_ACCOUNT; },
    signInBoth() { state = { ...MODEL_API_ACCOUNT, connections: [...MODEL_API_ACCOUNT.connections, { provider: "openai-codex", authType: "oauth", subscription: true }] }; },
    settled: () => queue };
}

const MODEL_API_ACCOUNT = {
  status: "signedIn",
  account: { provider: "mochi-byok", authType: "api_key", subscription: false, label: "Test", model: "mochi-byok/gpt-test" },
  connections: [{ provider: "mochi-byok", authType: "api_key", subscription: false, label: "Test", model: "mochi-byok/gpt-test" }],
} as const satisfies RuntimeAccountState;

test("BYOK failures preserve known correction codes but never invite a validation retry after an unknown outcome", async () => {
  for (const [error, code] of [
    [new RuntimeRequestError("byok_auth_rejected", "account.configureByok", "private provider text"), "byok_auth_rejected"],
    [new RuntimeRequestError("byok_timeout", "account.configureByok", "private provider text"), "byok_timeout"],
    [new RuntimeRequestError("account_configuration_failed", "account.configureByok", "private persistence error"), "account_status_unavailable"],
    [new Error("transport closed"), "account_status_unavailable"],
  ] as const) {
    const f = fixture();
    await f.account.start();
    f.failConfiguration(error);
    try {
      await f.account.configureByok({ baseUrl: "https://example.com/v1", label: "Example", model: "gpt-5", apiKey: "fixture-only-key" });
      throw new Error("Expected rejected connection");
    } catch (failure) {
      expect(failure).toBeInstanceOf(ControlRejection);
      expect((failure as Error).message).toBe(code);
    }
    expect(f.configurations).toBe(1);
    expect(f.account.snapshot()).toEqual({ status: "signedOut" });
    await f.account.close();
  }
});

test("the shared login works without a Bot and ignores completion after cancellation", async () => {
  const f = fixture();
  await f.account.start();
  await f.account.startChatGPTLogin();
  expect(f.account.snapshot().status).toBe("signingIn");
  await f.account.cancelChatGPTLogin();
  f.observer.loginCompleted({ loginId: "attempt", success: true });
  await f.settled();
  expect(f.account.snapshot().status).toBe("signedOut");
  expect(f.logins).toBe(1);
  await f.account.close();
});

function participant(provider: string, overrides: Partial<AccountParticipant> = {}) {
  const calls: string[] = [];
  const value: AccountParticipant = {
    usesConnection: (candidate) => candidate === provider,
    withAccountChange: (operation) => { calls.push("gate"); return operation(); },
    pauseForAccountChange: async () => { calls.push("pause"); },
    reconcileAccount: async () => { calls.push("reconcile"); },
    accountChanged: async () => { calls.push("settle"); },
    accountUnavailable() { calls.push("unavailable"); },
    ...overrides,
  };
  return { value, calls };
}

test("every gate the change reaches must succeed before the first Bot is paused", async () => {
  const first = participant("openai-codex");
  const busy = participant("openai-codex", { withAccountChange: async () => { throw new ControlRejection("connection_change_busy"); } });
  const f = fixture([first.value, busy.value]);
  f.signIn();
  await f.account.start();
  await expect(f.account.logoutChatGPT()).rejects.toThrow("connection_change_busy");
  expect(first.calls).not.toContain("pause");
  expect(f.account.snapshot().status).toBe("signedIn");
  await f.account.close();
});

test("a change to one connection gates and pauses only the Bots that use it", async () => {
  const chatgpt = participant("openai-codex");
  // A busy Bot on a model API cannot block, or be paused by, a ChatGPT change.
  const modelApi = participant("mochi-byok", { withAccountChange: async () => { throw new ControlRejection("connection_change_busy"); } });
  const f = fixture([chatgpt.value, modelApi.value]);
  f.signIn();
  await f.account.start();
  await f.account.logoutChatGPT();
  expect(chatgpt.calls).toEqual(["gate", "pause", "reconcile"]);
  expect(modelApi.calls).toEqual(["settle"]);
  expect(f.account.snapshot().status).toBe("signedOut");
  await f.account.close();
});

test("a ChatGPT login beside a model API keeps that connection published and pauses no Bot", async () => {
  const chatgpt = participant("openai-codex");
  const modelApi = participant("mochi-byok", { withAccountChange: async () => { throw new ControlRejection("connection_change_busy"); } });
  const f = fixture([chatgpt.value, modelApi.value]);
  f.useModelApi();
  await f.account.start();
  await f.account.startChatGPTLogin();
  expect(f.account.snapshot()).toEqual({ ...MODEL_API_ACCOUNT, pendingLogin: "openai-codex" });
  expect([...chatgpt.calls, ...modelApi.calls]).toEqual(["settle", "settle"]);
  await expect(f.account.logoutChatGPT()).rejects.toThrow("login_must_complete");
  f.signInBoth();
  f.observer.loginCompleted({ loginId: "attempt", success: true });
  await f.settled();
  expect(f.account.snapshot().status).toBe("signedIn");
  expect(f.account.snapshot()).not.toHaveProperty("pendingLogin");
  expect(chatgpt.calls).toEqual(["settle", "settle"]);
  expect(modelApi.calls).toEqual(["settle", "settle"]);
  await f.account.close();
});

test("an acknowledged account mutation is not success when authoritative readback fails", async () => {
  const f = fixture();
  f.signIn();
  await f.account.start();
  f.failReads();
  await expect(f.account.logoutChatGPT()).rejects.toThrow("account_status_unavailable");
  expect(f.account.snapshot().status).toBe("unknown");
  await f.account.close();
});

test("closing the shared owner ignores late account events", async () => {
  const f = fixture();
  await f.account.start();
  await f.account.startChatGPTLogin();
  await f.account.close();
  const count = f.snapshots.length;
  f.observer.runtimeUnavailable?.();
  f.observer.accountUpdated();
  f.observer.loginCompleted({ loginId: "attempt", success: true });
  await f.settled();
  expect(f.snapshots).toHaveLength(count);
});
