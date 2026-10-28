import { expect, test } from "bun:test";
import { authorityFixture } from "./fixture.ts";

test("the customer service cannot mint a maintainer token, even with its valid secret", async () => {
  const customer = await authorityFixture();
  expect((await customer.maintainer("token")).status).toBe(404);
  expect((await customer.maintainer("status")).status).toBe(404);
  expect(customer.calls).toHaveLength(0);
});

test("the maintainer service does not accept customer grants or Issue writes", async () => {
  const maintainer = await authorityFixture("maintainer");
  expect(
    (
      await maintainer.issue({
        method: "POST",
        path: "/issues",
        body: { title: "fixture" },
      })
    ).status,
  ).toBe(404);
  expect(maintainer.calls).toHaveLength(0);
  expect((await maintainer.maintainer("token")).status).toBe(200);
  const jwt = maintainer.calls[0]!.authorization!.slice("Bearer ".length);
  expect(
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).iss,
  ).toBe(900001);
});

test("deployments hold separate App identities, origins, limiter namespaces and secret bindings", async () => {
  const customer = Bun.JSONC.parse(
    await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text(),
  ) as {
    name: string;
    main: string;
    vars: Record<string, string>;
    routes: { pattern: string }[];
    secrets: { required: string[] };
    ratelimits: { namespace_id: string }[];
  };
  const maintainer = Bun.JSONC.parse(
    await Bun.file(
      new URL("../maintainer.wrangler.jsonc", import.meta.url),
    ).text(),
  ) as {
    name: string;
    main: string;
    vars: Record<string, string>;
    routes: { pattern: string }[];
    secrets: { required: string[] };
    ratelimits: { namespace_id: string }[];
  };
  expect(customer.vars.GITHUB_APP_ID).not.toBe(maintainer.vars.GITHUB_APP_ID);
  expect(customer.name).not.toBe(maintainer.name);
  expect(customer.main).not.toBe(maintainer.main);
  expect(customer.routes[0]!.pattern).not.toBe(maintainer.routes[0]!.pattern);
  expect(customer.secrets.required).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
  expect(
    Object.keys(customer.vars).some((key) => key.startsWith("MAINTAINER_")),
  ).toBeFalse();
  expect(maintainer.secrets.required.sort()).toEqual([
    "GITHUB_APP_PRIVATE_KEY",
    "MAINTAINER_AUTH_TOKEN",
  ]);
  const namespaces = [...customer.ratelimits, ...maintainer.ratelimits].map(
    (limit) => limit.namespace_id,
  );
  expect(new Set(namespaces).size).toBe(namespaces.length);
});
