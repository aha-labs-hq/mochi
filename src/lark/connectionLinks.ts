import { isFeishuAppId } from "./connectionProof.ts";
import { FEISHU_REQUESTABLE_SCOPES } from "./permissions.ts";
import { LARK_PLATFORMS, isLarkOpenOrigin, type LarkBrand } from "./platform.ts";

/** Official lark-cli v1.0.93 errs.ConsoleURL uses this consent page and exact keys.
 * Only the connection owner chooses the App and missing tenant scopes; no arbitrary redirect.
 */
export function feishuSettingsUrl(appId: string, missingScopes: readonly string[], brand: LarkBrand = "feishu"): string {
  return feishuScopeApplyUrl(appId, missingScopes, FEISHU_REQUESTABLE_SCOPES, brand);
}

export function isFeishuSettingsUrl(value: string): boolean {
  return isFeishuScopeApplyUrl(value, FEISHU_REQUESTABLE_SCOPES);
}

/** The one owner of the consent-page shape; each caller names the scopes it may request. */
export function feishuScopeApplyUrl(appId: string, missingScopes: readonly string[],
  requestable: readonly string[], brand: LarkBrand = "feishu"): string {
  if (!isFeishuAppId(appId) || !validScopes(missingScopes, requestable)) throw new Error("Invalid Feishu settings target");
  const origin = LARK_PLATFORMS[brand].open;
  if (!missingScopes.length) return `${origin}/app/${appId}`;
  return `${origin}/page/scope-apply?${new URLSearchParams({ clientID: appId, scopes: missingScopes.join(",") })}`;
}

export function isFeishuScopeApplyUrl(value: string, requestable: readonly string[]): boolean {
  try {
    const url = new URL(value);
    if (!isLarkOpenOrigin(url.origin) || url.username || url.password || url.hash) return false;
    if (/^\/app\/cli_[a-zA-Z0-9_]{1,128}$/.test(url.pathname)) return !url.search;
    if (url.pathname !== "/page/scope-apply" || [...url.searchParams.keys()].sort().join(",") !== "clientID,scopes") return false;
    const scopes = url.searchParams.get("scopes")!.split(",");
    return isFeishuAppId(url.searchParams.get("clientID")) && scopes.length > 0 && validScopes(scopes, requestable);
  } catch { return false; }
}
function validScopes(scopes: readonly string[], requestable: readonly string[]): boolean {
  return scopes.length <= requestable.length && new Set(scopes).size === scopes.length
    && scopes.every((scope) => requestable.includes(scope));
}
