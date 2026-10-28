import { expect, test } from "bun:test";
import { boundedJson, InstallationTokenCache } from "../src/github.ts";
import { handleAuthorityRequest } from "../src/index.ts";
import { authorityFixture } from "./fixture.ts";

function issueRequest(body?: ReadableStream<Uint8Array>) {
  return new Request("https://authority.mochi.invalid/v1/issues", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      Authorization: "Bearer ghu_fixture",
      "Content-Type": "application/json",
    },
    body:
      body ??
      JSON.stringify({
        version: 1,
        accountId: 1,
        repository: {
          id: 20,
          ownerId: 10,
          installationId: 30,
          fullName: "customer/selected",
        },
        operation: {
          method: "POST",
          path: "/issues",
          body: { title: "fixture" },
        },
      }),
  });
}

test("a stalled body is canceled, even when its cancellation callback never settles", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  await expect(boundedJson(new Response(stream), 100, 20)).rejects.toThrow(
    "provider_response_invalid",
  );
  expect(canceled).toBeTrue();
});

test("a slow incoming body is canceled before it can occupy a provider request", async () => {
  const f = await authorityFixture();
  let canceled = false,
    calls = 0;
  const request = issueRequest(
    new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
  );
  const response = await handleAuthorityRequest(request, f.env, {
    tokens: new InstallationTokenCache(),
    fetchImplementation: (async () => {
      calls++;
      throw new Error("must not reach GitHub");
    }) as unknown as typeof fetch,
  });
  expect(response.status).toBe(400);
  expect(canceled).toBeTrue();
  expect(calls).toBe(0);
}, 7_000);

test("the provider deadline aborts the actual network request", async () => {
  const f = await authorityFixture();
  let aborted = false;
  const response = await handleAuthorityRequest(issueRequest(), f.env, {
    tokens: new InstallationTokenCache(),
    fetchImplementation: (async (_input: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      })) as unknown as typeof fetch,
  });
  expect(response.status).toBe(503);
  expect(aborted).toBeTrue();
}, 18_000);
