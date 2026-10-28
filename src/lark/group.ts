/** Renderer-safe group facts. Membership is established only by the bot's official group list. */
export interface FeishuGroup {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  enabled: boolean;
}

export const MAXIMUM_FEISHU_GROUPS = 1_000;
export const FEISHU_CHAT_ID_PATTERN = "^oc_[A-Za-z0-9_]{1,128}$";

export function isFeishuChatId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(FEISHU_CHAT_ID_PATTERN).test(value);
}

export function isGroupName(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value));
}

/** Only image CDN URLs returned by Feishu; never arbitrary renderer navigation or host fetch. */
export function isGroupAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 4_096 || !/^[\x21-\x7e]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
      && /^(s\d+-imfile\.feishucdn\.com|p\d+-lark-file\.byteimg\.com)$/.test(url.hostname);
  } catch { return false; }
}

export function isFeishuGroup(value: unknown): value is FeishuGroup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const group = value as Record<string, unknown>;
  return Object.keys(group).sort().join(",") === "avatarUrl,enabled,id,name"
    && isFeishuChatId(group.id) && isGroupName(group.name)
    && isGroupAvatarUrl(group.avatarUrl) && typeof group.enabled === "boolean";
}

/** null is unavailable, [] is a successfully confirmed empty membership list. */
export function isFeishuGroups(value: unknown): value is readonly FeishuGroup[] | null {
  return value === null || (Array.isArray(value) && value.length <= MAXIMUM_FEISHU_GROUPS
    && value.every(isFeishuGroup) && new Set(value.map((group) => group.id)).size === value.length);
}
