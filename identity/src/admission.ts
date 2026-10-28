import { isIP } from "node:net";
import { enforceLimit } from "./github.ts";
import { AuthorityError } from "./protocol.ts";

/** Edge-owned source identity, never a token or a client-claimed GitHub account. */
export async function admitRequest(
  request: Request,
  limiter: RateLimit,
): Promise<void> {
  // Cloudflare supplies this on direct public ingress; no same-zone proxy may rewrite it. Refuse a
  // missing edge identity instead of collapsing clients into a shared bucket.
  const address = request.headers.get("CF-Connecting-IP");
  if (!address || !isIP(address)) throw new AuthorityError("invalid_request");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address),
  );
  const key = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await enforceLimit(limiter, `source:${key}`);
}
