import type { RuntimeAccountObserver } from "./client.ts";
import type {
  RuntimeAccountState,
  RuntimeLoginAttempt,
  RuntimeLoginCompletion,
} from "./protocol.ts";

const LOGIN_TIMEOUT_MILLISECONDS = 10 * 60_000;

interface RuntimeLoginClient {
  accountRead(): Promise<RuntimeAccountState>;
  startChatGPTLogin(): Promise<RuntimeLoginAttempt>;
  cancelChatGPTLogin(loginId: string): Promise<void>;
}

type AuthorizationUrlOpener = (authorizationUrl: string) => Promise<void>;

/** Bridges Pi's asynchronous OAuth completion event into the one explicit bootstrap command. */
export class RuntimeLoginObserver implements RuntimeAccountObserver {
  readonly #completions = new Map<string, RuntimeLoginCompletion>();
  readonly #waiters = new Map<string, (completion: RuntimeLoginCompletion) => void>();

  accountUpdated(): void {}

  loginCompleted(completion: RuntimeLoginCompletion): void {
    const waiter = this.#waiters.get(completion.loginId);
    if (waiter) {
      this.#waiters.delete(completion.loginId);
      waiter(completion);
    } else {
      this.#completions.set(completion.loginId, completion);
    }
  }

  wait(loginId: string): Promise<RuntimeLoginCompletion> {
    if (this.#waiters.has(loginId)) {
      return Promise.reject(new Error(`A login observer is already waiting for ${loginId}`));
    }
    const completed = this.#completions.get(loginId);
    if (completed) {
      this.#completions.delete(loginId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#waiters.delete(loginId);
        reject(new Error("ChatGPT browser login timed out after 10 minutes"));
      }, LOGIN_TIMEOUT_MILLISECONDS);
      this.#waiters.set(loginId, (completion) => {
        clearTimeout(timeout);
        resolve(completion);
      });
    });
  }
}

export async function ensureBootstrapLogin(
  client: RuntimeLoginClient,
  observer: RuntimeLoginObserver,
  openAuthorizationUrl: AuthorizationUrlOpener = openInDefaultBrowser,
): Promise<void> {
  if ((await client.accountRead()).status === "signedIn") return;
  const attempt = await client.startChatGPTLogin();
  try {
    await openAuthorizationUrl(attempt.authorizationUrl);
  } catch (error) {
    await client.cancelChatGPTLogin(attempt.loginId).catch(() => undefined);
    throw error;
  }
  let completion: RuntimeLoginCompletion;
  try {
    completion = await observer.wait(attempt.loginId);
  } catch (error) {
    await client.cancelChatGPTLogin(attempt.loginId).catch(() => undefined);
    throw error;
  }
  if (!completion.success) throw new Error(completion.error ?? "ChatGPT browser login did not complete");
  if ((await client.accountRead()).status !== "signedIn") {
    throw new Error("Pi reported a completed login without a signed-in ChatGPT account");
  }
}

async function openInDefaultBrowser(authorizationUrl: string): Promise<void> {
  const open = Bun.spawn({
    cmd: ["/usr/bin/open", authorizationUrl],
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(open.stderr).text(), open.exited]);
  if (code !== 0) {
    throw new Error(`/usr/bin/open failed (${code}): ${stderr.trim().slice(0, 2_000)}`);
  }
}
