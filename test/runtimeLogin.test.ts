import { describe, expect, test } from "bun:test";
import { ensureBootstrapLogin, RuntimeLoginObserver } from "../src/runtime/login.ts";
import type { RuntimeAccountState } from "../src/runtime/protocol.ts";

describe("Pi runtime login observer", () => {
  test("delivers OAuth completion whether it arrives before or after the waiter", async () => {
    const observer = new RuntimeLoginObserver();
    observer.loginCompleted({ loginId: "early", success: true });
    expect(await observer.wait("early")).toEqual({ loginId: "early", success: true });

    const waiting = observer.wait("late");
    observer.loginCompleted({ loginId: "late", success: false, error: "cancelled" });
    expect(await waiting).toEqual({ loginId: "late", success: false, error: "cancelled" });
  });

  test("rejects duplicate consumers for one server-owned login", async () => {
    const observer = new RuntimeLoginObserver();
    const first = observer.wait("login-1");
    await expect(observer.wait("login-1")).rejects.toThrow("already waiting");
    observer.loginCompleted({ loginId: "login-1", success: true });
    await expect(first).resolves.toEqual({ loginId: "login-1", success: true });
  });

  test("bootstraps the official browser login for a previously signed-out runtime", async () => {
    const observer = new RuntimeLoginObserver();
    let account: RuntimeAccountState = { status: "signedOut" };
    const opened: string[] = [];
    const client = {
      accountRead: async () => account,
      startChatGPTLogin: async () => ({
        loginId: "login-1",
        authorizationUrl: "https://auth.openai.com/authorize",
      }),
      cancelChatGPTLogin: async () => { throw new Error("login must not be cancelled"); },
    };

    await ensureBootstrapLogin(client, observer, async (authorizationUrl) => {
      opened.push(authorizationUrl);
      account = {
        status: "signedIn",
        account: { provider: "openai-codex", authType: "oauth", subscription: true },
      connections: [{ provider: "openai-codex", authType: "oauth", subscription: true }],
      };
      observer.loginCompleted({ loginId: "login-1", success: true });
    });

    expect(opened).toEqual(["https://auth.openai.com/authorize"]);
  });

  test("cancels the server-owned login when the browser cannot be opened", async () => {
    const observer = new RuntimeLoginObserver();
    const cancellations: string[] = [];
    const client = {
      accountRead: async (): Promise<RuntimeAccountState> => ({ status: "signedOut" }),
      startChatGPTLogin: async () => ({
        loginId: "login-1",
        authorizationUrl: "https://auth.openai.com/authorize",
      }),
      cancelChatGPTLogin: async (loginId: string) => { cancellations.push(loginId); },
    };

    await expect(ensureBootstrapLogin(client, observer, async () => {
      throw new Error("browser unavailable");
    })).rejects.toThrow("browser unavailable");
    expect(cancellations).toEqual(["login-1"]);
  });
});
