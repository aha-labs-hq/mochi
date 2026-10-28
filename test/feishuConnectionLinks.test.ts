import { expect, test } from "bun:test";
import { feishuSettingsUrl, isFeishuSettingsUrl } from "../src/lark/connectionLinks.ts";
import { MOCHI_CONTROL_PROTOCOL_VERSION, parseControlResponse } from "../src/control/protocol.ts";

test("official scope consent is limited to the fixed missing tenant capabilities and the exact app", () => {
  const url = feishuSettingsUrl("cli_customer", ["im:message.group_msg"]);
  expect(new URL(url).searchParams.get("scopes")).toBe("im:message.group_msg");
  expect(isFeishuSettingsUrl(url)).toBe(true);
  expect(parseControlResponse(JSON.stringify({ version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, authorizationUrl: url }), "feishu_settings").authorizationUrl).toBe(url);
  for (const invalid of [
    `${url}&redirect_uri=https://example.com`, `${url}&clientID=cli_other`, `${url}#secret`,
    url.replace("open.feishu.cn", "open.feishu.cn.example.com"),
    url.replace("im%3Amessage.group_msg", "contact%3Auser%3Areadonly"),
    url.replace("im%3Amessage.group_msg", "im%3Amessage.group_msg%2Cim%3Amessage.group_msg"),
    "https://open.feishu.cn/app/cli_customer?token=secret",
  ]) {
    expect(isFeishuSettingsUrl(invalid)).toBe(false);
    expect(() => parseControlResponse(JSON.stringify({ version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, authorizationUrl: invalid }), "feishu_settings")).toThrow();
  }
  expect(() => feishuSettingsUrl("cli_customer&evil=1", [])).toThrow();
  expect(() => feishuSettingsUrl("cli_customer", ["contact:user:readonly"])).toThrow();
  expect(feishuSettingsUrl("cli_customer", [])).toBe("https://open.feishu.cn/app/cli_customer");
  const international = feishuSettingsUrl("cli_customer", ["im:message.group_msg"], "lark");
  expect(new URL(international).origin).toBe("https://open.larksuite.com");
  expect(isFeishuSettingsUrl(international)).toBeTrue();
  expect(isFeishuSettingsUrl(international.replace("open.larksuite.com", "open.larksuite.com.example.test"))).toBeFalse();
});
