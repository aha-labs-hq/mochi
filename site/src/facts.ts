import { MINIMUM_MACOS_VERSION } from "../../src/product/version.ts";
import type { SiteRelease } from "./context.ts";

/** The one line that says what Mochi is, wherever the site names it. */
export const tagline = "住在飞书群里的项目伙伴";

/** The application form for the beta. Support and privacy go by email. */
export const betaApplicationUrl =
  "https://pcnbm7fly2bp.feishu.cn/share/base/shrcnucFT2Q9ukcoN1h22s8V7hd";

/* Beta packages are built on Apple silicon; an accepted release states its
   own architecture and minimum system. */
const BETA_ARCHITECTURE: SiteRelease["architecture"] = "arm64";

export function macName(architecture: SiteRelease["architecture"]) {
  return architecture === "arm64" ? "Apple 芯片 Mac" : "Intel Mac";
}

/** The published version's name, which says when it is the public beta. */
export function releaseName(release: SiteRelease) {
  return `Mochi ${release.productVersion}${release.channel === "public-beta" ? " 公开测试版" : ""}`;
}

/** What a team prepares before its first conversation with Mochi. */
export function needs(release: SiteRelease | null) {
  const mac = macName(release?.architecture ?? BETA_ARCHITECTURE);
  const system = release?.minimumMacOS ?? MINIMUM_MACOS_VERSION;
  return [
    `一台 ${mac}，macOS ${system} 或更新版本`,
    "ChatGPT Plus 或 Pro 订阅，或兼容 Responses API 的 API Key",
    "飞书或 Lark 组织，可能需要管理员审批",
    "GitHub 账号和要用的项目",
  ];
}

/**
 * Who makes Mochi, as search engines and the footer name it. The legal
 * publisher, when reviewed, comes from publication.
 */
export const maker = {
  name: "Aha Labs",
  url: "https://ahalabs.site/",
  sameAs: ["https://github.com/aha-labs-hq"],
};
