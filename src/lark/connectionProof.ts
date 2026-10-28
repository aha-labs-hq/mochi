import { FeishuConnectionError, type FeishuBot } from "./connectionState.ts";
import { isGroupAvatarUrl, isGroupName } from "./group.ts";
import { missingConnectionScopes, LARK_APPLICATION_PROOF_SCOPES, parseTenantScopeInventory } from "./permissions.ts";
import { runLarkJson, type LarkContext } from "./process.ts";
import { isLarkBrand, type LarkBrand } from "./platform.ts";

export interface FeishuIdentity { appId: string; botOpenId: string; brand: LarkBrand }
export interface FeishuConnectionProof extends FeishuIdentity {
  bot: FeishuBot;
  problem: "permissions_required" | "permissions_approval_required" | "group_messages_required" | "publication_required" | null;
  missingScopes: readonly string[];
  grantedScopes: readonly string[];
}
export const isFeishuAppId = (value: unknown): value is string => typeof value === "string" && /^cli_[a-zA-Z0-9_]{1,128}$/.test(value);
export const isFeishuBotOpenId = (value: unknown): value is string => typeof value === "string" && /^ou_[a-zA-Z0-9_]{1,128}$/.test(value);

/** Official CLI verification is deliberately separate from creation success.
 * auth status proves the bot; tenant grants prove operations; the published App
 * record proves availability and supplies its actual name and avatar.
 */
export async function proveFeishuConnection(context: LarkContext, expected?: Partial<FeishuIdentity>, read = runLarkJson): Promise<FeishuConnectionProof> {
  const call = async (args: readonly string[]) => {
    try { return await read(context, args); }
    catch { throw new FeishuConnectionError("provider_unavailable"); }
  };
  const auth = await call(["auth", "status", "--verify", "--json"]);
  if (!record(auth) || !record(auth.identities) || !record(auth.identities.bot)) throw new FeishuConnectionError("provider_response_invalid");
  const bot = auth.identities.bot;
  if (auth.verified !== true || !isLarkBrand(auth.brand) || bot.verified !== true || bot.status !== "ready" || bot.available !== true) {
    throw new FeishuConnectionError("credential_unavailable");
  }
  if (!isFeishuAppId(auth.appId) || !isFeishuBotOpenId(bot.openId)) throw new FeishuConnectionError("provider_response_invalid");
  if (typeof bot.appName !== "string" || !isGroupName(bot.appName)) throw new FeishuConnectionError("provider_response_invalid");
  const identity = { appId: auth.appId, botOpenId: bot.openId, brand: auth.brand };
  if ((expected?.brand && auth.brand !== expected.brand) || (expected?.appId && auth.appId !== expected.appId) || (expected?.botOpenId && bot.openId !== expected.botOpenId)) {
    throw new FeishuConnectionError("identity_changed");
  }
  let inventory: ReturnType<typeof parseTenantScopeInventory>;
  try { inventory = parseTenantScopeInventory(await call(["api", "GET", "/open-apis/application/v6/scopes", "--as", "bot", "--json"])); }
  catch (error) { if (error instanceof FeishuConnectionError) throw error; throw new FeishuConnectionError("provider_response_invalid"); }
  const missingScopes = missingConnectionScopes(inventory.granted);
  const permissionProblem = !missingScopes.length ? null
    : missingScopes.every((scope) => inventory.ungranted.includes(scope)) ? "permissions_approval_required"
    : missingScopes.includes("im:message.group_msg") ? "group_messages_required" : "permissions_required";
  if (!LARK_APPLICATION_PROOF_SCOPES.some((scope) => inventory.granted.includes(scope))) {
    return { ...identity, missingScopes, grantedScopes: inventory.granted, bot: { name: bot.appName, avatarUrl: null }, problem: permissionProblem };
  }
  // bot/v3/info returns a top-level `bot` that lark-cli's generic JSON renderer
  // omits in v1.0.93. Use the documented application resource, not an empty result.
  const result = await call(["api", "GET", "/open-apis/application/v6/applications/me",
    "--params", JSON.stringify({ lang: "zh_cn" }), "--as", "bot", "--json"]);
  if (!record(result) || result.ok !== true || result.identity !== "bot" || !record(result.data) || !record(result.data.app)) {
    throw new FeishuConnectionError("provider_response_invalid");
  }
  const app = result.data.app;
  if (app.app_id !== auth.appId) throw new FeishuConnectionError("identity_changed");
  const published = app.status === 1 && typeof app.online_version_id === "string" && app.online_version_id.length > 0;
  if (typeof app.app_name !== "string" || !isGroupName(app.app_name)) throw new FeishuConnectionError("provider_response_invalid");
  return { ...identity, missingScopes, grantedScopes: inventory.granted,
    bot: { name: app.app_name, avatarUrl: isGroupAvatarUrl(app.avatar_url) ? app.avatar_url : null },
    problem: permissionProblem ?? (published ? null : "publication_required") };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
