import { expect, test } from "bun:test";
import { admitRequest } from "../src/admission.ts";
import { InstallationTokenCache } from "../src/github.ts";
import { handleAuthorityRequest } from "../src/index.ts";
import { authorityFixture, FixtureLimiter } from "./fixture.ts";

test("invalid credentials spend the edge-source budget before any upstream request or body read", async () => {
  const f = await authorityFixture();
  let upstream = 0,
    bodyReads = 0;
  const fetchImplementation = (async () => {
    upstream++;
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }) as unknown as typeof fetch;
  const request = () =>
    new Request("https://authority.mochi.invalid/v1/issues", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        Authorization: "Bearer ghu_invalid_fixture",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
  const handle = (r: Request) =>
    handleAuthorityRequest(r, f.env, {
      tokens: new InstallationTokenCache(),
      fetchImplementation,
    });
  expect((await handle(request())).status).toBe(401);
  expect(upstream).toBe(1);
  expect(f.limits.request.keys).toHaveLength(1);
  expect(f.limits.account.keys).toHaveLength(0);
  f.limits.request.allowed = false;
  const blocked = request();
  Object.defineProperty(blocked, "body", {
    get() {
      bodyReads++;
      throw new Error("body must not be read");
    },
  });
  const response = await handle(blocked);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(bodyReads).toBe(0);
  expect(upstream).toBe(1);
});

test("source admission never uses a claimed account, raw address, forwarded-for or token as its key", async () => {
  const limiter = new FixtureLimiter();
  for (const token of ["ghu_first", "ghu_second"]) {
    await admitRequest(
      new Request("https://authority.mochi.invalid/v1/issues", {
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "X-Forwarded-For": token,
          Authorization: token,
        },
      }),
      limiter,
    );
  }
  expect(limiter.keys[0]).toMatch(/^source:[a-f0-9]{64}$/);
  expect(limiter.keys[0]).toBe(limiter.keys[1]);
  expect(limiter.keys[0]).not.toContain("203.0.113.10");
  await expect(
    admitRequest(new Request("https://authority.mochi.invalid/"), limiter),
  ).rejects.toThrow();
  await expect(
    admitRequest(
      new Request("https://authority.mochi.invalid/", {
        headers: { "CF-Connecting-IP": "invalid" },
      }),
      limiter,
    ),
  ).rejects.toThrow();
  expect(limiter.keys).toHaveLength(2);
});

test("an unavailable source limiter fails closed", async () => {
  const f = await authorityFixture();
  f.limits.request.limit = async () => {
    throw new Error("unavailable");
  };
  const response = await f.issue({
    method: "POST",
    path: "/issues",
    body: { title: "fixture" },
  });
  expect(response.status).toBe(503);
  expect(f.calls).toHaveLength(0);
});
