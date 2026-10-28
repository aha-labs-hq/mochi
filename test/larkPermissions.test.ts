import { describe, expect, test } from "bun:test";
import { compareTenantScopes, parseGrantedTenantScopes, REQUIRED_LARK_TENANT_SCOPES } from "../src/lark/permissions.ts";

describe("Lark tenant scope requirements", () => {
  test("accepts the minimum scopes", () => {
    expect(compareTenantScopes(REQUIRED_LARK_TENANT_SCOPES)).toEqual({ missing: [], extra: [] });
  });

  test("uses Feishu's current read-only group information scope", () => {
    expect(REQUIRED_LARK_TENANT_SCOPES).toContain("im:chat:read");
    expect(REQUIRED_LARK_TENANT_SCOPES).not.toContain("im:chat.group_info:readonly");
    expect(REQUIRED_LARK_TENANT_SCOPES).not.toContain("im:chat.members:read");
    expect(REQUIRED_LARK_TENANT_SCOPES).toContain("wiki:node:read");
    expect(REQUIRED_LARK_TENANT_SCOPES).not.toContain("wiki:node:retrieve");
  });

  test("reports retained extra scopes without treating them as missing", () => {
    expect(compareTenantScopes([
      ...REQUIRED_LARK_TENANT_SCOPES,
      "im:message:recall",
    ])).toEqual({ missing: [], extra: ["im:message:recall"] });
  });

  test("reports missing required scopes and unrelated authority separately", () => {
    expect(compareTenantScopes([
      "im:message.group_at_msg:readonly",
      "im:message:send_as_bot",
      "im:message:recall",
    ])).toEqual({
      missing: [
        "docx:document:readonly",
        "drive:drive.metadata:readonly",
        "im:chat:read",
        "im:message.group_msg",
        "im:message.reactions:write_only",
        "im:message:readonly",
        "wiki:node:read",
      ],
      extra: ["im:message.group_at_msg:readonly", "im:message:recall"],
    });
  });
});

const scope = (scope_name: string, scope_type = "tenant", grant_status = 1) => ({ scope_name, scope_type, grant_status });
const envelope = (scopes: unknown[]) => ({ ok: true, identity: "bot", data: { scopes } });

test("tenant proof excludes personal authorization and requested-but-ungranted permissions", () => {
  expect(parseGrantedTenantScopes(envelope([
    scope("im:chat:read"), scope("im:message.group_msg", "tenant", 2),
    scope("wiki:node:read", "user"), scope("offline_access", "user"),
  ]))).toEqual(["im:chat:read"]);
  expect(compareTenantScopes(parseGrantedTenantScopes(envelope(
    REQUIRED_LARK_TENANT_SCOPES.filter((name) => name !== "im:message.group_msg").map((name) => scope(name)),
  ))).missing).toEqual(["im:message.group_msg"]);
});

test("failed, incomplete or ambiguous provider inventory never becomes an authority proof", () => {
  const complete = envelope(REQUIRED_LARK_TENANT_SCOPES.map((name) => scope(name)));
  for (const value of [
    { ...complete, ok: false }, { ...complete, identity: "user" }, { data: complete.data },
    { ok: true, identity: "bot", data: {} }, envelope([null]), envelope([{}]),
    envelope([scope("im:chat:read"), scope("im:chat:read", "tenant", 2)]),
    envelope([scope("im:chat:read", "unknown")]), envelope([scope("im:chat:read", "tenant", 3)]),
    envelope([scope("bad\nsecret")]), envelope(Array.from({ length: 1_001 }, (_, index) => scope(`scope:${index}`))),
  ]) expect(() => parseGrantedTenantScopes(value)).toThrow("feishu_scope_response_invalid");
  expect(parseGrantedTenantScopes(complete)).toEqual(REQUIRED_LARK_TENANT_SCOPES);
});
