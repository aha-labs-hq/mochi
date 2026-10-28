/** Runtime operations, not an installer template, own the required authority.
 * +chat-list proves bot membership without reading the human member directory.
 * drive +inspect resolves Wiki nodes through the current get_node read scope.
 */
export const REQUIRED_LARK_TENANT_SCOPES = Object.freeze([
  "docx:document:readonly",
  "drive:drive.metadata:readonly",
  "im:chat:read",
  "im:message.group_msg",
  "im:message.reactions:write_only",
  "im:message:readonly",
  "im:message:send_as_bot",
  "wiki:node:read",
] as const);

/** The official CLI's successful bot envelope is the only accepted scope proof.
 * User scopes, requested-but-ungranted scopes and error bodies cannot prove access.
 * Reject malformed/duplicate inventory instead of silently filtering it into success.
 */
export function parseTenantScopeInventory(value: unknown): { granted: readonly string[]; ungranted: readonly string[] } {
  if (!record(value) || value.ok !== true || value.identity !== "bot" || !record(value.data)
    || !Array.isArray(value.data.scopes) || value.data.scopes.length > 1_000) {
    throw new Error("feishu_scope_response_invalid");
  }
  const seen = new Set<string>();
  const granted: string[] = [];
  const ungranted: string[] = [];
  for (const entry of value.data.scopes) {
    if (!record(entry) || typeof entry.scope_name !== "string"
      || !/^[a-z][a-z0-9_.:]{0,255}$/.test(entry.scope_name)
      || (entry.scope_type !== "tenant" && entry.scope_type !== "user")
      || (entry.grant_status !== 1 && entry.grant_status !== 2)) {
      throw new Error("feishu_scope_response_invalid");
    }
    const key = `${entry.scope_type}:${entry.scope_name}`;
    if (seen.has(key)) throw new Error("feishu_scope_response_invalid");
    seen.add(key);
    if (entry.scope_type === "tenant") (entry.grant_status === 1 ? granted : ungranted).push(entry.scope_name);
  }
  return { granted: Object.freeze(granted), ungranted: Object.freeze(ungranted) };
}

export function parseGrantedTenantScopes(value: unknown): readonly string[] {
  return parseTenantScopeInventory(value).granted;
}

/** Publication proof can inspect this application, or use an existing admin read grant. */
export const LARK_APPLICATION_PROOF_SCOPES = ["application:application:self_manage", "admin:app.info:readonly"] as const;
export const FEISHU_REQUESTABLE_SCOPES = [...REQUIRED_LARK_TENANT_SCOPES, LARK_APPLICATION_PROOF_SCOPES[0]] as const;

export function missingConnectionScopes(granted: readonly string[]): string[] {
  return [...compareTenantScopes(granted).missing,
    ...(LARK_APPLICATION_PROOF_SCOPES.some((scope) => granted.includes(scope)) ? [] : [LARK_APPLICATION_PROOF_SCOPES[0]])];
}

export function compareTenantScopes(actualScopes: readonly string[]): {
  missing: string[];
  extra: string[];
} {
  const required = new Set<string>(REQUIRED_LARK_TENANT_SCOPES);
  const actual = new Set(actualScopes);
  return {
    missing: REQUIRED_LARK_TENANT_SCOPES.filter((scope) => !actual.has(scope)),
    extra: [...actual].filter((scope) => !required.has(scope)).sort(),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
