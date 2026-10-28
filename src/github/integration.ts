/** Public issuer identity. Customer grants and issuer private keys never belong here. */
export const GITHUB_INTEGRATION = Object.freeze({
  appId: 4850106,
  clientId: "Iv23liuyiwWBMnGlBIra",
  slug: "mochi-companion",
  authorizationIssuer: "https://github.com/login/oauth",
  callback: "http://127.0.0.1:43827/oauth/github/callback",
  authorityUrl: "https://github-auth.mochi.host",
  installationUrl: "https://github.com/apps/mochi-companion/installations/new",
  authorizationSettingsUrl: "https://github.com/settings/apps/authorizations",
});

export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** Closed failure vocabulary; provider bodies and credentials must not escape this boundary. */
export const GITHUB_CONNECTION_FAILURES = [
  "issuer_not_configured", "authorization_in_progress", "authorization_cancelled",
  "authorization_expired", "authorization_denied", "authorization_invalid", "callback_unavailable",
  "sign_in_required", "credential_unavailable", "provider_unavailable", "provider_response_invalid",
  "grant_unavailable", "repository_not_selected", "repository_changed", "issue_write_not_granted",
] as const;
export type GitHubConnectionFailure = typeof GITHUB_CONNECTION_FAILURES[number];

export class GitHubConnectionError extends Error {
  constructor(readonly code: GitHubConnectionFailure) {
    super(code);
    this.name = "GitHubConnectionError";
  }
}
