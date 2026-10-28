/** Official CLI v1.0.93 core.ResolveEndpoints; never caller-supplied hosts. */
export type LarkBrand = "feishu" | "lark";
export const LARK_PLATFORMS = Object.freeze({
  feishu: Object.freeze({
    name: "飞书",
    open: "https://open.feishu.cn",
    accounts: "https://accounts.feishu.cn",
    appLink: "https://applink.feishu.cn",
  }),
  lark: Object.freeze({
    name: "Lark",
    open: "https://open.larksuite.com",
    accounts: "https://accounts.larksuite.com",
    appLink: "https://applink.larksuite.com",
  }),
});
export function isLarkBrand(value: unknown): value is LarkBrand {
  return value === "feishu" || value === "lark";
}
export function isLarkOpenOrigin(origin: string): boolean {
  return Object.values(LARK_PLATFORMS).some(
    (platform) => platform.open === origin,
  );
}
export function isLarkAuthorizationUrl(
  value: string,
  brand?: LarkBrand,
): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (brand ? [LARK_PLATFORMS[brand]] : Object.values(LARK_PLATFORMS)).some(
        (platform) =>
          url.origin === platform.open || url.origin === platform.accounts,
      )
    );
  } catch {
    return false;
  }
}
