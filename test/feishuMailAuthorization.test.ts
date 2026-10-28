import { describe, expect, test } from "bun:test";
import {
  FeishuMailAuthorization,
  FeishuMailAuthorizationError,
} from "../src/connectors/feishu-mail/authorization.ts";
import { FEISHU_MAIL_USER_SCOPES } from "../src/connectors/feishu-mail/manifest.ts";

const context = {
  cliPath: "/native/lark-cli",
  profile: "mochi",
  configDirectory: "/private/mail",
} as const;

const ENABLED = {
  appId: "cli_fixture",
  brand: "feishu",
  tokenType: "user",
  userScopes: [...FEISHU_MAIL_USER_SCOPES, "contact:user.base:readonly"],
  count: FEISHU_MAIL_USER_SCOPES.length + 1,
};

// auth login --no-wait --json returns device-flow fields directly, unlike
// the ok/data envelope used by the CLI's OpenAPI commands.
const DEVICE_FLOW = {
  verification_url:
    "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=TEST",
  device_code: "device-secret",
  expires_in: 240,
};

type Options = { timeoutMilliseconds?: number; signal?: AbortSignal };

/** A fake official CLI whose device-code poll stays open until the test answers it. */
function cli(overrides: { scopes?: unknown; login?: unknown } = {}) {
  const calls: { args: string[]; options: Options | undefined }[] = [];
  let answer!: (approved: boolean) => void;
  const run = async (
    _context: unknown,
    args: readonly string[],
    options?: Options,
  ): Promise<unknown> => {
    calls.push({ args: [...args], options });
    if (args[1] === "scopes") return overrides.scopes ?? ENABLED;
    if (args.includes("--no-wait")) return overrides.login ?? DEVICE_FLOW;
    return new Promise((resolve, reject) => {
      answer = (approved) =>
        approved
          ? resolve({ event: "authorization_complete" })
          : reject(new Error("lark-cli exited 3"));
      options?.signal?.addEventListener("abort", () =>
        reject(new Error("lark-cli aborted")),
      );
    });
  };
  return { calls, run, answer: (approved: boolean) => answer(approved) };
}

describe("Feishu mail authorization", () => {
  test("Lark consent uses its own platform and refuses a cross-platform device URL", async () => {
    const international = { ...context, brand: "lark" as const };
    const fake = cli({ login: { ...DEVICE_FLOW, verification_url: DEVICE_FLOW.verification_url.replace("accounts.feishu.cn", "accounts.larksuite.com") } });
    const auth = new FeishuMailAuthorization(fake.run);
    const attempt = await auth.start(international);
    expect(attempt.authorizationUrl).toContain("accounts.larksuite.com");
    fake.answer(true); await attempt.settled;
    await expect(new FeishuMailAuthorization(cli().run).start(international)).rejects.toThrow("authorization_response_invalid");
    const missing = new FeishuMailAuthorization(cli({ scopes: { ...ENABLED, userScopes: [] } }).run);
    expect(await missing.scopeApplyUrl(international, "cli_fixture")).toStartWith("https://open.larksuite.com/page/scope-apply?");
  });
  test("checks the app, requests only read-only scopes and polls without a report from the user", async () => {
    const fake = cli();
    const authorization = new FeishuMailAuthorization(fake.run);
    const attempt = await authorization.start(context);
    expect(attempt).toMatchObject({
      authorizationUrl: DEVICE_FLOW.verification_url,
      resumed: false,
    });
    expect(JSON.stringify(attempt)).not.toContain("device-secret");
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["auth", "scopes", "--json"],
      [
        "auth",
        "login",
        "--scope",
        FEISHU_MAIL_USER_SCOPES.join(" "),
        "--no-wait",
        "--json",
      ],
      ["auth", "login", "--device-code", "device-secret", "--json"],
    ]);
    // The poll outlives lark-cli's own 600 s device-code deadline.
    expect(fake.calls[2]!.options?.timeoutMilliseconds).toBeGreaterThan(600_000);
    expect(authorization.pending(context)).toBe(true);
    fake.answer(true);
    await expect(attempt.settled).resolves.toBe("approved");
    expect(authorization.pending(context)).toBe(false);
  });

  test("hands back the attempt already waiting instead of issuing a second code", async () => {
    const fake = cli();
    const authorization = new FeishuMailAuthorization(fake.run);
    const first = await authorization.start(context);
    const second = await authorization.start(context);
    expect(second).toMatchObject({
      authorizationUrl: first.authorizationUrl,
      resumed: true,
    });
    expect(second.settled).toBe(first.settled);
    expect(fake.calls).toHaveLength(3);
  });

  test("two simultaneous starts issue one device code", async () => {
    const fake = cli();
    const authorization = new FeishuMailAuthorization(fake.run);
    const [first, second] = await Promise.all([
      authorization.start(context),
      authorization.start(context),
    ]);
    expect([first.resumed, second.resumed]).toEqual([false, true]);
    expect(
      fake.calls.filter((call) => call.args.includes("--no-wait")),
    ).toHaveLength(1);
  });

  test("does not start a grant the app cannot give and names the missing scopes", async () => {
    const fake = cli({
      scopes: { ...ENABLED, userScopes: ["mail:user_mailbox:readonly"] },
    });
    const authorization = new FeishuMailAuthorization(fake.run);
    await expect(authorization.start(context)).rejects.toMatchObject({
      code: "app_scope_required",
    });
    expect(fake.calls.map((call) => call.args[1])).toEqual(["scopes"]);
    const url = new URL(
      await authorization.scopeApplyUrl(context, "cli_fixture"),
    );
    expect(url.origin + url.pathname).toBe(
      "https://open.feishu.cn/page/scope-apply",
    );
    expect(url.searchParams.get("clientID")).toBe("cli_fixture");
    expect(url.searchParams.get("scopes")?.split(",")).toEqual(
      FEISHU_MAIL_USER_SCOPES.filter(
        (scope) => scope !== "mail:user_mailbox:readonly",
      ),
    );
  });

  test("treats an app without user scopes as missing every mail scope", async () => {
    const authorization = new FeishuMailAuthorization(
      cli({ scopes: { ...ENABLED, userScopes: null, count: 0 } }).run,
    );
    await expect(authorization.missingAppScopes(context)).resolves.toEqual(
      FEISHU_MAIL_USER_SCOPES,
    );
  });

  test("reports a refused, expired or partial grant as incomplete, not approved", async () => {
    // lark-cli exits 3 for a denial, an expiry, and a grant missing scopes
    // (after storing that token); the caller re-proves the identity instead.
    const fake = cli();
    const authorization = new FeishuMailAuthorization(fake.run);
    const attempt = await authorization.start(context);
    fake.answer(false);
    await expect(attempt.settled).resolves.toBe("incomplete");
    expect(authorization.pending(context)).toBe(false);
  });

  test("cancelling stops the poll and leaves no attempt behind", async () => {
    const fake = cli();
    const authorization = new FeishuMailAuthorization(fake.run);
    const attempt = await authorization.start(context);
    await authorization.cancel();
    expect(fake.calls[2]!.options?.signal?.aborted).toBe(true);
    await expect(attempt.settled).resolves.toBe("cancelled");
    expect(authorization.pending(context)).toBe(false);
  });

  test("rejects a provider error even when it includes handoff fields", async () => {
    const authorization = new FeishuMailAuthorization(
      cli({ login: { ok: false, ...DEVICE_FLOW } }).run,
    );
    await expect(authorization.start(context)).rejects.toMatchObject({
      code: "authorization_response_invalid",
    });
    expect(authorization.pending(context)).toBe(false);
  });

  test("logging out stops a waiting attempt and requires the CLI's own answer", async () => {
    const fake = cli();
    const loggedOut = new FeishuMailAuthorization(async (context, args, options) =>
      args[1] === "logout" ? { ok: true, loggedOut: true } : fake.run(context, args, options),
    );
    const attempt = await loggedOut.start(context);
    await loggedOut.logout(context);
    await expect(attempt.settled).resolves.toBe("cancelled");
    expect(loggedOut.pending(context)).toBe(false);
    const malformed = new FeishuMailAuthorization(async () => ({ ok: true }));
    await expect(malformed.logout(context)).rejects.toMatchObject({
      code: "authorization_response_invalid",
    });
  });

  test("rejects unsafe provider URLs", async () => {
    const authorization = new FeishuMailAuthorization(
      cli({
        login: { ...DEVICE_FLOW, verification_url: "https://evil.example.test/authorize" },
      }).run,
    );
    await expect(authorization.start(context)).rejects.toBeInstanceOf(
      FeishuMailAuthorizationError,
    );
    expect(authorization.pending(context)).toBe(false);
  });

  test("rejects an app scope answer that is not the user-token inventory", async () => {
    const authorization = new FeishuMailAuthorization(
      cli({ scopes: { ...ENABLED, tokenType: "tenant" } }).run,
    );
    await expect(authorization.start(context)).rejects.toMatchObject({
      code: "authorization_response_invalid",
    });
  });
});
