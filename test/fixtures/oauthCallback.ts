import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { chatGPTCallbackPages } from "../../src/oauthPage.ts";

// A separate process prevents the fetch guard or global SDK registration from
// affecting other tests. No provider request or real credential is permitted.
const originalFetch = globalThis.fetch;
let exchanges = 0;
globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === "https://auth.openai.com/oauth/token") {
    exchanges++;
    throw new Error("fixture-token-exchange-denied");
  }
  throw new Error("Unexpected network request in OAuth fixture");
}, { preconnect: originalFetch.preconnect });

const directory = await mkdtemp(join(tmpdir(), "mochi-oauth-fixture-"));
const abort = new AbortController();
try {
  registerBunOAuthFlows({ openaiCodexCallbackPages: chatGPTCallbackPages });
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const authorization = Promise.withResolvers<URL>();
  const login = runtime.login("openai-codex", "oauth", {
    signal: abort.signal,
    prompt: async (prompt) => {
      if (prompt.type === "select") return "browser";
      if (prompt.type !== "manual_code") throw new Error("Unexpected prompt");
      return new Promise<string>((_resolve, reject) => {
        const signal = prompt.signal ?? abort.signal;
        const cancel = () => reject(new Error("fixture-cancelled"));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    },
    notify: (event) => {
      if (event.type === "auth_url") authorization.resolve(new URL(event.url));
    },
  }).then(() => { throw new Error("Fixture unexpectedly logged in"); }, (error: Error) => error);
  const url = await authorization.promise;
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const state = url.searchParams.get("state")!;
  // The provider has a fixed callback port. A conflicting browser flow fails
  // before publishing a URL and never waits for unsupported pasted codes.
  const another = await ModelRuntime.create({authPath:join(directory,"another.json"),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  await assert.rejects(another.login("openai-codex","oauth",{
    signal: new AbortController().signal,
    prompt: async prompt => { assert.equal(prompt.type,"select"); return "browser"; },
    notify: () => { throw new Error("A conflicting login must not publish a URL"); },
  }), /callback is unavailable/);

  for (const [path, status] of [
    ["/wrong-route", 404],
    ["/auth/callback?code=fixture-code&state=wrong", 400],
    [`/auth/callback?state=${state}`, 400],
  ] as const) {
    const response = await originalFetch(`http://127.0.0.1:1455${path}`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(await response.text(), chatGPTCallbackPages.rejected);
    assert.equal(exchanges, 0);
  }
  const response = await originalFetch(`http://127.0.0.1:1455/auth/callback?code=fixture-code&state=${state}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), chatGPTCallbackPages.received);
  const failure = await login;
  assert.match(failure.message, /fixture-token-exchange-denied/);
  assert.equal(exchanges, 1);
  assert.equal(await runtime.checkAuth("openai-codex"), undefined);
  const cancelled = new AbortController();
  const cancellation = runtime.login("openai-codex","oauth",{
    signal:cancelled.signal,
    prompt:async prompt => {
      if(prompt.type === "select") return "browser";
      return new Promise<string>((_,reject)=>{
        const signal=prompt.signal!;const fail=()=>reject(new Error("fixture-cancelled"));
        if(signal.aborted)fail();else signal.addEventListener("abort",fail,{once:true});
      });
    },
    notify:event=>{if(event.type==="auth_url")cancelled.abort();},
  });
  await assert.rejects(cancellation,/cancel|abort/i);
  assert.equal(await runtime.checkAuth("openai-codex"), undefined);
  console.log("Branded callback received/rejected; SDK validation and failed exchange preserved");
} finally {
  abort.abort();
  await rm(directory, { recursive: true, force: true });
}
