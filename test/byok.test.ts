import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BYOK_PROVIDER, byokModelReference, isByokAccountSummary, parseByokConnection, parseByokSetup, parseModelReference } from "../src/runtime/byok.ts";
import { ByokAccount, registerByokProvider } from "../src/runtime/byokAccount.ts";
import { parseAccountState } from "../src/runtime/client.ts";
import { OPENAI_CODEX_PROVIDER } from "../src/runtime/protocol.ts";

const setup = { baseUrl: "https://example.com/v1", model: "gpt-5.6-terra", label: "Example" };
const key = "fixture-key-not-live";
const directories: string[] = [];
const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const success: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "OK" }], api: "openai-responses", provider: BYOK_PROVIDER, model: setup.model,
  timestamp: 1, stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
function validation(reply = success) {
  const mock = spyOn(ModelRuntime.prototype, "completeSimple").mockResolvedValue(reply);
  restores.push(() => mock.mockRestore()); return mock;
}
async function fixture(directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-byok-")))) {
  if (!directories.includes(directory)) directories.push(directory);
  chmodSync(directory, 0o700);
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const account = new ByokAccount(runtime, directory);
  await account.restore();
  return { directory, runtime, account };
}

test("BYOK inputs and public account facts are closed and credential-free", () => {
  expect(parseByokSetup({ ...setup, baseUrl: `${setup.baseUrl}/` })).toEqual(setup);
  expect(parseModelReference(byokModelReference("vendor/model"))).toEqual({ provider: BYOK_PROVIDER, model: "vendor/model" });
  for (const input of [{ ...setup, apiKey: "bad\nkey" }, { ...setup, apiKey: " key" }, { ...setup, baseUrl: "http://example.com", apiKey: key }, { ...setup, apiKey: key, headers: {} }]) expect(() => parseByokConnection(input)).toThrow();
  for (const model of ["", "gpt-5", "mochi-byok/", "mochi-byok/x\n"]) expect(() => parseAccountState({ status: "signedIn", account: { provider: BYOK_PROVIDER, authType: "api_key", subscription: false, label: "Example", model } })).toThrow();
});

test("BYOK uses Pi's Responses metadata without inventing limits or loading ambient models.json", async () => {
  const f = await fixture();
  writeFileSync(join(f.directory, "models.json"), '{"providers":{"evil":{"apiKey":"!touch forbidden"}}}');
  const model = await registerByokProvider(f.runtime, setup);
  const source = f.runtime.getModel("openai", setup.model)!;
  expect(model.api).toBe("openai-responses");
  expect(model.contextWindow).toBe(source.contextWindow);
  expect(model.thinkingLevelMap).toEqual(source.thinkingLevelMap);
  expect(model.maxTokens).toBe(source.maxTokens);
  expect(f.runtime.getProvider("evil")).toBeUndefined();
  await expect(registerByokProvider(f.runtime, { ...setup, model: "invented-model" })).rejects.toThrow("supported by Pi");
});

test("the production account path validates, commits, resumes and removes using Pi auth storage", async () => {
  const mock = validation();
  const f = await fixture();
  await f.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]![0]).toMatchObject({ provider: BYOK_PROVIDER, api: "openai-responses", baseUrl: setup.baseUrl });
  expect(readFileSync(join(f.directory, "byok.json"), "utf8")).not.toContain(key);
  expect(statSync(join(f.directory, "byok.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(f.directory, "auth.json"), "utf8")).toContain(key);
  const restarted = await fixture(f.directory);
  expect(parseAccountState(await restarted.account.read())).toEqual({ status: "signedIn", account: { provider: BYOK_PROVIDER, authType: "api_key", subscription: false, label: setup.label, model: byokModelReference(setup.model) }, connections: [{ provider: BYOK_PROVIDER, authType: "api_key", subscription: false, label: setup.label, model: byokModelReference(setup.model) }] });
  await expect(restarted.account.configure({ ...setup, apiKey: "replacement" }, AbortSignal.timeout(5000))).rejects.toThrow("Disconnect");
  await restarted.account.remove();
  expect(await restarted.account.read()).toEqual({ status: "signedOut" });
  expect(existsSync(join(f.directory, "byok.json"))).toBeFalse();
  expect(readFileSync(join(f.directory, "auth.json"), "utf8")).not.toContain(key);
});

test("ChatGPT and API Key can remain connected together", async () => {
  const f = await fixture();
  writeFileSync(join(f.directory, "byok.json"), JSON.stringify(setup), { mode: 0o600 });
  const checkAuth = spyOn(f.runtime, "checkAuth").mockImplementation(async (provider) =>
    provider === OPENAI_CODEX_PROVIDER ? { type: "oauth" } : { type: "api_key" },
  );
  restores.push(() => checkAuth.mockRestore());
  expect(await f.account.read()).toEqual({
    status: "signedIn",
    account: { provider: OPENAI_CODEX_PROVIDER, authType: "oauth", subscription: true },
    connections: [
      { provider: OPENAI_CODEX_PROVIDER, authType: "oauth", subscription: true },
      { provider: BYOK_PROVIDER, authType: "api_key", subscription: false, label: setup.label, model: byokModelReference(setup.model) },
    ],
  });
});

test("multiple named model APIs can be added, edited and removed independently", async () => {
  validation();
  const f = await fixture();
  await f.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000));
  const second = { baseUrl: "https://gateway.example/v1", model: "gpt-5.6-terra", label: "Gateway" };
  await f.account.configure({ ...second, apiKey: "second-key" }, AbortSignal.timeout(5000));
  const connected = await f.account.read();
  expect(connected.status).toBe("signedIn");
  if (connected.status !== "signedIn") return;
  expect(connected.connections).toHaveLength(2);
  const gateway = connected.connections.find((connection) => isByokAccountSummary(connection) && connection.label === "Gateway");
  expect(gateway?.provider).toMatch(/^mochi-byok-[a-z0-9]{32}$/);
  expect(gateway && isByokAccountSummary(gateway) ? gateway.model : undefined).toBe(gateway && isByokAccountSummary(gateway) ? byokModelReference(gateway.provider, second.model) : undefined);
  await f.account.configure({ ...second, label: "Gateway edited", apiKey: "second-key", connectionId: gateway!.provider }, AbortSignal.timeout(5000));
  const edited = await f.account.read();
  expect(edited.status).toBe("signedIn");
  if (edited.status !== "signedIn") return;
  expect(edited.connections.some((connection) => isByokAccountSummary(connection) && connection.label === "Gateway edited")).toBe(true);
  await f.account.remove(BYOK_PROVIDER);
  const remaining = await f.account.read();
  expect(remaining.status).toBe("signedIn");
  if (remaining.status !== "signedIn") return;
  expect(remaining.connections).toHaveLength(1);
});

test("rejected or incomplete Responses never persist credentials or leak provider errors", async () => {
  const mock = validation({ ...success, stopReason: "error", content: [], errorMessage: `Authorization: ${key}` });
  const f = await fixture();
  await expect(f.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000))).rejects.toThrow("could not be verified");
  expect(await f.account.read()).toEqual({ status: "signedOut" });
  expect(existsSync(join(f.directory, "byok.json"))).toBeFalse();
  expect(existsSync(join(f.directory, "auth.json")) && readFileSync(join(f.directory, "auth.json"), "utf8").includes(key)).toBeFalse();
  mock.mockResolvedValue({ ...success, stopReason: "length" });
  await expect(f.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000))).rejects.toThrow();
});

test("an interrupted declaration is signed out; failed credential deletion retains its configuration", async () => {
  validation(); const f = await fixture();
  writeFileSync(join(f.directory, "byok.json"), JSON.stringify(setup), { mode: 0o600 });
  const restarted = await fixture(f.directory);
  expect(await restarted.account.read()).toEqual({ status: "signedOut" });
  await restarted.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000));
  const logout = spyOn(restarted.runtime, "logout").mockRejectedValue(new Error("disk failure")); restores.push(() => logout.mockRestore());
  await expect(restarted.account.remove()).rejects.toThrow("disk failure");
  expect((await restarted.account.read()).status).toBe("signedIn");
  expect(existsSync(join(f.directory, "byok.json"))).toBeTrue();
});

test("unsafe configuration and credentials without configuration fail closed", async () => {
  const f = await fixture();
  const source = join(f.directory, "source.json"); writeFileSync(source, JSON.stringify(setup), { mode: 0o600 });
  symlinkSync(source, join(f.directory, "byok.json"));
  await expect(f.account.restore()).rejects.toThrow("Invalid private");
  rmSync(join(f.directory, "byok.json"));
  await registerByokProvider(f.runtime, setup);
  await f.runtime.login(BYOK_PROVIDER, "api_key", { prompt: async () => key, notify: () => {} });
  await expect(fixture(f.directory)).rejects.toThrow("no provider configuration");
});

for (const [status, code] of [
  [401, "byok_auth_rejected"], [403, "byok_auth_rejected"],
  [404, "byok_endpoint_unavailable"], [429, "byok_rate_limited"],
  [503, "byok_service_unavailable"], [400, "byok_connection_failed"],
] as const) {
  test(`Pi HTTP ${status} yields safe actionable feedback without saving or retrying`, async () => {
    const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(
      JSON.stringify({ error: { message: `private provider echo ${key}` } }),
      { status, headers: { "Content-Type": "application/json" } },
    ), { preconnect: fetch.preconnect }));
    restores.push(() => request.mockRestore());
    const f = await fixture();
    try {
      await f.account.configure({ ...setup, apiKey: key }, AbortSignal.timeout(5000));
      throw new Error("Expected rejected validation");
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect(String(error)).not.toContain(key);
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(await f.account.read()).toEqual({ status: "signedOut" });
    expect(existsSync(join(f.directory, "byok.json"))).toBeFalse();
    expect(existsSync(join(f.directory, "auth.json")) && readFileSync(join(f.directory, "auth.json"), "utf8").includes(key)).toBeFalse();
  });
}

for (const timeout of [false, true]) {
  test(`Pi ${timeout ? "timeout" : "network failure"} stops validation without persisting the key`, async () => {
    const abort = new AbortController();
    const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (timeout) abort.abort();
      throw new Error(`Network error echo ${key}`);
    }, { preconnect: fetch.preconnect }));
    restores.push(() => request.mockRestore());
    const f = await fixture();
    await expect(f.account.configure({ ...setup, apiKey: key }, abort.signal)).rejects.toMatchObject({
      code: timeout ? "byok_timeout" : "byok_network_unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await f.account.read()).toEqual({ status: "signedOut" });
    expect(existsSync(join(f.directory, "byok.json"))).toBeFalse();
  });
}
