import { expect, spyOn, test } from "bun:test";
import type { TurnExecution } from "../src/runtime/execution.ts";
import { PublicNetworkUnavailableError } from "../src/runtime/executionNetwork.ts";
import { parseBingResults, parseDuckDuckGoResults, webResearchTools } from "../src/runtime/webResearch.ts";

test("public search parsers preserve source links and remove tracking wrappers", () => {
  const html = `
    <div class="result results_links">
      <a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=ignored">Example &amp; guide</a>
      <a class="result__snippet">Primary <b>source</b> &amp; details</a>
    </div>`;
  expect(parseDuckDuckGoResults(html)).toEqual([{
    title: "Example & guide",
    url: "https://example.com/guide",
    snippet: "Primary source & details",
  }]);
});

test("Bing parser ignores malformed and non-http result links", () => {
  const html = `
    <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9h">A</a></h2><div class="b_caption"><p>One</p></div></li>
    <li class="b_algo"><h2><a href="javascript:alert(1)">bad</a></h2></li>
    <li class="b_algo"><h2><a href="https://example.com/b">B</a></h2><div class="b_caption"><p>Two</p></div></li>`;
  expect(parseBingResults(html)).toEqual([
    { title: "A", url: "https://example.com/a", snippet: "One" },
    { title: "B", url: "https://example.com/b", snippet: "Two" },
  ]);
});

test("web_fetch reports an HTTP failure page as a failed fetch, not page content", async () => {
  // Pi returns a non-zero curl exit as an error result rather than throwing.
  const respond = (status: number) => ({
    execute: async (_name: string, args: { command: string }) => {
      const marker = args.command.match(/MOCHI_WEB_[0-9a-f]+/)![0];
      const body = status === 200 ? "<title>Guide</title><p>Public text</p>" : "<h1>Not Found</h1>";
      return status === 200
        ? { content: [{ type: "text", text: `${body}${marker}:text/html` }] }
        : { content: [{ type: "text", text: `${body}${marker}:text/html\n\nCommand exited with code 22` }], isError: true };
    },
  }) as unknown as TurnExecution;
  const fetch = (status: number) => webResearchTools(() => respond(status))
    .find(({ name }) => name === "web_fetch")!
    .execute("call", { url: "https://example.com/guide" }, undefined, undefined, undefined as never);
  expect((await fetch(200)).content[0]).toMatchObject({ text: expect.stringContaining("Public text") });
  await expect(fetch(404)).rejects.toThrow("Command exited with code 22");
});

// A turn execution whose sandboxed curl answers per URL; a fake-IP reply marks the turn as the proxy would.
function scriptedExecution(respond: (url: URL) => { body: string; failed?: boolean; fakeIp?: boolean }) {
  const requested: string[] = [];
  const execution = {
    publicNetworkError: undefined as PublicNetworkUnavailableError | undefined,
    execute: async (_name: string, args: { command: string }) => {
      const marker = args.command.match(/MOCHI_WEB_[0-9a-f]+/)![0];
      const url = new URL(args.command.match(/'(https?:[^']+)'$/)![1]!);
      requested.push(url.hostname);
      const reply = respond(url);
      if (reply.fakeIp) execution.publicNetworkError ??= new PublicNetworkUnavailableError(url.hostname);
      return reply.failed
        ? { content: [{ type: "text", text: `${reply.body}\n\nCommand exited with code 35` }], isError: true }
        : { content: [{ type: "text", text: `${reply.body}${marker}:text/html` }] };
    },
  };
  const call = (name: string, params: Record<string, unknown>) => webResearchTools(() => execution as unknown as TurnExecution)
    .find((tool) => tool.name === name)!
    .execute("call", params, undefined, undefined, undefined as never);
  return { call, requested };
}

const bingPage = `<li class="b_algo"><h2><a href="https://example.com/b">B</a></h2><div class="b_caption"><p>Two</p></div></li>`;

test("web_search names the Bing fallback and why DuckDuckGo did not answer", async () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (const [duckDuckGo, reason] of [
      [{ body: "curl: (35) TLS connect error", failed: true }, "failed: curl: (35) TLS connect error"],
      [{ body: "<html>no results</html>" }, "returned no results"],
    ] as const) {
      const { call } = scriptedExecution((url) => url.hostname === "www.bing.com" ? { body: bingPage } : duckDuckGo);
      const result = await call("web_search", { query: "public question" });
      const response = JSON.parse((result.content[0] as { text: string }).text);
      expect(response).toMatchObject({ provider: "bing", fallback: { from: "duckduckgo", reason }, results: [{ url: "https://example.com/b" }] });
      expect(result.details).toMatchObject({ provider: "bing", fallback: { from: "duckduckgo", reason } });
      expect(log.mock.calls.at(-1)?.[0]).toContain("runtime.web_search.fallback");
    }
  } finally { log.mockRestore(); }
});

test("web_search reports both providers when neither answers", async () => {
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { call } = scriptedExecution((url) => ({ body: url.hostname === "www.bing.com" ? "curl: (7) Failed to connect" : "curl: (6) Could not resolve host", failed: true }));
    await expect(call("web_search", { query: "public question" })).rejects.toThrow(/DuckDuckGo failed: curl: \(6\).*Bing failed: curl: \(7\)/);
  } finally { log.mockRestore(); }
});

test("web research fails closed after a fake-IP refusal and tries no other destination", async () => {
  const { call, requested } = scriptedExecution(() => ({ body: "curl: (56) CONNECT tunnel failed, response 403", failed: true, fakeIp: true }));
  await expect(call("web_search", { query: "public question" })).rejects.toBeInstanceOf(PublicNetworkUnavailableError);
  await expect(call("web_fetch", { url: "https://example.com/guide" })).rejects.toThrow("fake-IP");
  expect(requested).toEqual(["html.duckduckgo.com"]);
});
