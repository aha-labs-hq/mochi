import { describe, expect, test } from "bun:test";
import {
  feishuAuthorizationGroups,
  feishuScopeLabel,
} from "../src/ui/feishuAuthorization.ts";
import { connectedFeishuScopes } from "./connectedFacts.ts";

describe("Feishu authorization presentation", () => {
  test("keeps the complete granted inventory grouped by service boundary", () => {
    const groups = feishuAuthorizationGroups(connectedFeishuScopes);
    expect(connectedFeishuScopes).toHaveLength(41);
    expect(groups.map((group) => [group.id, group.scopes.length])).toEqual([
      ["messaging", 21],
      ["content", 11],
      ["application", 9],
    ]);
    expect(groups.flatMap((group) => group.scopes)).toHaveLength(41);
  });

  test("does not lose a newly granted provider scope", () => {
    const groups = feishuAuthorizationGroups([
      "im:message.group_msg",
      "future:scope:read",
    ]);
    expect(groups.at(-1)).toMatchObject({
      id: "other",
      scopes: ["future:scope:read"],
    });
  });

  test("uses a human label while retaining the exact scope name", () => {
    expect(feishuScopeLabel("docx:document:readonly")).toBe("读取云文档");
    expect(feishuScopeLabel("future:scope:read")).toBe("future:scope:read");
  });
});
