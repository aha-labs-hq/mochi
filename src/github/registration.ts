import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { GITHUB_INTEGRATION, GitHubConnectionError } from "./integration.ts";

interface GitHubClientRegistration {
  version: 1;
  clientId: typeof GITHUB_INTEGRATION.clientId;
  clientSecret: string;
}

/** Native OAuth registration is not a user grant or an issuer RSA signing key.
 * Native client secrets are extractable; PKCE and explicit user consent remain mandatory.
 */
export function parseGitHubClientRegistration(value: unknown): GitHubClientRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "clientId,clientSecret,version") throw new GitHubConnectionError("issuer_not_configured");
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || data.clientId !== GITHUB_INTEGRATION.clientId || typeof data.clientSecret !== "string"
    || !/^[A-Za-z0-9_]{20,256}$/.test(data.clientSecret)) throw new GitHubConnectionError("issuer_not_configured");
  return { version: 1, clientId: GITHUB_INTEGRATION.clientId, clientSecret: data.clientSecret };
}

export function readGitHubClientRegistration(path: string, owner: number): GitHubClientRegistration {
  return readRegistration(path, owner, 0o022);
}

/** Read-only package validation, dispatched before any Bridge or account state exists. */
export function runValidation(args: readonly string[]): void {
  if (args.length !== 1 || !isAbsolute(args[0]!)) {
    throw new Error("Usage: --validate-github-registration /absolute/github-oauth.json");
  }
  readGitHubClientRegistration(args[0]!, process.getuid!());
}

/** Build/deploy-time handoff only; the destination must be a new staged resource.
 * No customer credential is read, no existing resource is overwritten, and failures
 * never include file contents. The caller's existing transaction owns publication.
 */
export function stageGitHubClientRegistration(source: string, destination: string): void {
  const registration = readRegistration(source, process.getuid!(), 0o077);
  // The installed resource is root-owned but must be readable by the Bridge user.
  // This extractable native registration is not the issuer's private signing key.
  const descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444);
  try { writeFileSync(descriptor, `${JSON.stringify(registration)}\n`); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  const staged = readGitHubClientRegistration(destination, process.getuid!());
  if (JSON.stringify(staged) !== JSON.stringify(registration)) throw new GitHubConnectionError("issuer_not_configured");
}

function readRegistration(path: string, owner: number, forbiddenMode: number): GitHubClientRegistration {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new GitHubConnectionError("issuer_not_configured"); }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || (stat.mode & forbiddenMode) !== 0 || stat.size > 4096) throw new Error();
    return parseGitHubClientRegistration(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch { throw new GitHubConnectionError("issuer_not_configured"); }
  finally { closeSync(descriptor); }
}
