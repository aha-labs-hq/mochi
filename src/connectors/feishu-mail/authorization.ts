import { feishuScopeApplyUrl } from "../../lark/connectionLinks.ts";
import { isLarkAuthorizationUrl } from "../../lark/platform.ts";
import { type LarkContext, runLarkJson } from "../../lark/process.ts";
import { FEISHU_MAIL_USER_SCOPES } from "./manifest.ts";

/**
 * Official lark-cli 1.0.93 polls a device code every 5 s for at most 600 s
 * (the server may expire it sooner). The wait adds a short grace period so the
 * CLI's own deadline, not this kill, ends an unanswered attempt.
 */
const AUTHORIZATION_WAIT_MILLISECONDS = 630_000;

export type FeishuMailAuthorizationFailure =
  | "authorization_response_invalid"
  | "authorization_unavailable"
  | "app_scope_required";

export class FeishuMailAuthorizationError extends Error {
  readonly code: FeishuMailAuthorizationFailure;

  constructor(
    code: FeishuMailAuthorizationFailure,
    options?: { cause?: unknown },
  ) {
    super(`Feishu mail authorization: ${code}`, options);
    this.name = "FeishuMailAuthorizationError";
    this.code = code;
  }
}

/**
 * How one device-flow attempt ended. It is not the proof: a partial grant
 * stores the new token and still exits non-zero, so the caller re-proves the
 * user identity whatever the outcome.
 */
export type FeishuMailAuthorizationOutcome =
  | "approved"
  | "incomplete"
  | "cancelled";

export interface FeishuMailAuthorizationAttempt {
  readonly authorizationUrl: string;
  /** Settles once the user answers, the code expires, or the attempt is cancelled. Never rejects. */
  readonly settled: Promise<FeishuMailAuthorizationOutcome>;
  /** True when an attempt already waiting for this connection was handed back. */
  readonly resumed: boolean;
}

/**
 * Owns one short-lived user device flow. Polling starts as soon as the URL is
 * issued, so the user only approves in Feishu; nobody has to report back. The
 * device code is memory-only and is never published as a Bot fact or persisted.
 */
export class FeishuMailAuthorization {
  #pending:
    | {
        readonly context: LarkContext;
        readonly authorizationUrl: string;
        readonly controller: AbortController;
        readonly settled: Promise<FeishuMailAuthorizationOutcome>;
      }
    | undefined;
  /** Two windows may start at once; one device code is issued at a time. */
  #starting: Promise<unknown> = Promise.resolve();

  constructor(private readonly run: typeof runLarkJson = runLarkJson) {}

  /** Whether an attempt for this exact connection is waiting for the user. */
  pending(context: LarkContext): boolean {
    return (
      this.#pending !== undefined && sameContext(this.#pending.context, context)
    );
  }

  /**
   * Mail scopes the Feishu app has not enabled for user tokens. A user cannot
   * grant those on the consent page, so asking first would only end in a
   * partial or refused grant.
   */
  async missingAppScopes(context: LarkContext): Promise<readonly string[]> {
    let value: unknown;
    try {
      value = await this.run(context, ["auth", "scopes", "--json"]);
    } catch (error) {
      throw new FeishuMailAuthorizationError("authorization_unavailable", {
        cause: error,
      });
    }
    const enabled = appUserScopes(value);
    return FEISHU_MAIL_USER_SCOPES.filter((scope) => !enabled.includes(scope));
  }

  /** The app owner's consent page for exactly the mail scopes still missing. */
  async scopeApplyUrl(context: LarkContext, appId: string): Promise<string> {
    return feishuScopeApplyUrl(
      appId,
      await this.missingAppScopes(context),
      FEISHU_MAIL_USER_SCOPES,
      context.brand,
    );
  }

  start(context: LarkContext): Promise<FeishuMailAuthorizationAttempt> {
    const started = this.#starting.then(() => this.#start(context));
    this.#starting = started.catch(() => undefined);
    return started;
  }

  async #start(context: LarkContext): Promise<FeishuMailAuthorizationAttempt> {
    const current = this.#pending;
    if (current && sameContext(current.context, context)) {
      return {
        authorizationUrl: current.authorizationUrl,
        settled: current.settled,
        resumed: true,
      };
    }
    await this.cancel();
    if ((await this.missingAppScopes(context)).length > 0) {
      throw new FeishuMailAuthorizationError("app_scope_required");
    }
    let value: unknown;
    try {
      value = await this.run(context, [
        "auth",
        "login",
        "--scope",
        FEISHU_MAIL_USER_SCOPES.join(" "),
        "--no-wait",
        "--json",
      ]);
    } catch (error) {
      throw new FeishuMailAuthorizationError("authorization_unavailable", {
        cause: error,
      });
    }
    const root = deviceFlowResponse(value);
    const authorizationUrl =
      stringValue(root.verification_url) ??
      stringValue(root.verification_uri_complete);
    const deviceCode = stringValue(root.device_code);
    if (
      !authorizationUrl ||
      !deviceCode ||
      !isLarkAuthorizationUrl(authorizationUrl, context.brand)
    ) {
      throw new FeishuMailAuthorizationError("authorization_response_invalid");
    }
    const controller = new AbortController();
    const settled = this.run(
      context,
      ["auth", "login", "--device-code", deviceCode, "--json"],
      {
        timeoutMilliseconds: AUTHORIZATION_WAIT_MILLISECONDS,
        signal: controller.signal,
      },
    ).then(
      (): FeishuMailAuthorizationOutcome => "approved",
      (): FeishuMailAuthorizationOutcome =>
        controller.signal.aborted ? "cancelled" : "incomplete",
    );
    const pending = {
      context: { ...context },
      authorizationUrl,
      controller,
      settled,
    };
    this.#pending = pending;
    void settled.then(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    return { authorizationUrl, settled, resumed: false };
  }

  /**
   * Removes every user grant from this connection's CLI profile. lark-cli asks
   * Feishu to revoke each token (best effort) and keeps the App credentials, so
   * the Bot identity is unaffected.
   */
  async logout(context: LarkContext): Promise<void> {
    await this.cancel();
    let value: unknown;
    try {
      value = await this.run(context, ["auth", "logout", "--json"]);
    } catch (error) {
      throw new FeishuMailAuthorizationError("authorization_unavailable", {
        cause: error,
      });
    }
    if (
      !record(value) ||
      value.ok !== true ||
      typeof value.loggedOut !== "boolean"
    ) {
      throw new FeishuMailAuthorizationError("authorization_response_invalid");
    }
  }

  /** Stops waiting for the user. Returns once the polling process has exited. */
  async cancel(): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.controller.abort();
    await pending.settled;
  }
}

function deviceFlowResponse(value: unknown): Record<string, unknown> {
  // auth login --json is a direct device-flow response. The command's
  // successful exit is checked by runLarkJson; it has no OpenAPI ok/data envelope.
  if (!record(value) || value.ok === false) {
    throw new FeishuMailAuthorizationError("authorization_response_invalid");
  }
  return value;
}

/** `auth scopes --json` prints the app's user-token scopes; an app with none prints null. */
function appUserScopes(value: unknown): readonly string[] {
  if (!record(value) || value.tokenType !== "user") {
    throw new FeishuMailAuthorizationError("authorization_response_invalid");
  }
  if (value.userScopes === null) return [];
  if (
    !Array.isArray(value.userScopes) ||
    value.userScopes.length > 1_000 ||
    !value.userScopes.every((scope) => typeof scope === "string")
  ) {
    throw new FeishuMailAuthorizationError("authorization_response_invalid");
  }
  return value.userScopes;
}

function sameContext(left: LarkContext, right: LarkContext): boolean {
  return (
    left.cliPath === right.cliPath &&
    left.profile === right.profile &&
    left.brand === right.brand &&
    left.configDirectory === right.configDirectory
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
