import { PrivateRecord } from "../privateRecord.ts";
import { GitHubConnectionError } from "./integration.ts";
import type { GitHubUserToken } from "./oauth.ts";
import { isGitHubId, isGitHubNonce } from "./repository.ts";

export interface GitHubCredential {
  version: 2;
  account: { id: number; login: string };
  grantId: string;
  token: GitHubUserToken;
}

/** Bridge-only persistence. One atomic record keeps rotating tokens and their grant inseparable. */
export interface GitHubCredentialStore {
  read(): GitHubCredential | undefined;
  write(credential: GitHubCredential): void;
  clear(): void;
}

export class GitHubFileCredentialStore extends PrivateRecord<GitHubCredential> implements GitHubCredentialStore {
  constructor(path: string) {
    super(path, parseCredential, () => new GitHubConnectionError("credential_unavailable"));
  }
}

export function parseCredential(value: unknown): GitHubCredential {
  const invalid = (): never => { throw new GitHubConnectionError("credential_unavailable"); };
  if (!record(value) || !keys(value, "account,grantId,token,version") || value.version !== 2
    || !record(value.account) || !keys(value.account, "id,login") || !isGitHubId(value.account.id)
    || typeof value.account.login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.account.login)
    || !isGitHubNonce(value.grantId) || !record(value.token)
    || !keys(value.token, "accessExpiresAt,accessToken,refreshExpiresAt,refreshToken")
    || typeof value.token.accessToken !== "string" || !/^ghu_[A-Za-z0-9_]{1,252}$/.test(value.token.accessToken)
    || typeof value.token.refreshToken !== "string" || !/^ghr_[A-Za-z0-9_]{1,252}$/.test(value.token.refreshToken)
    || !isGitHubId(value.token.accessExpiresAt) || !isGitHubId(value.token.refreshExpiresAt)
    || value.token.refreshExpiresAt <= value.token.accessExpiresAt) return invalid();
  return { version: 2, account: { id: value.account.id, login: value.account.login }, grantId: value.grantId,
    token: { accessToken: value.token.accessToken, refreshToken: value.token.refreshToken,
      accessExpiresAt: value.token.accessExpiresAt, refreshExpiresAt: value.token.refreshExpiresAt } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: object, expected: string): boolean { return Object.keys(value).sort().join(",") === expected; }
