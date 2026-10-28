import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MINIMUM_MACOS_VERSION } from "../../src/product/version.ts";
import {
  type SiteContext,
  SiteProvider,
  type SiteRelease,
} from "../src/context.ts";
import { ReleaseDownload, ReleaseFiles } from "../src/downloads.tsx";
import { needs, releaseName } from "../src/facts.ts";
import { type PageMetadata, pageHead } from "../src/seo.ts";
import { DownloadAction } from "../src/ui.tsx";

const prefix = "https://downloads.mochi-product.tld/Mochi-0.2.0-arm64-fixture/";
const release: SiteRelease = {
  channel: "release",
  productVersion: "0.2.0",
  architecture: "arm64",
  minimumMacOS: "14.0",
  limitations: ["Mac needs to remain awake — fixture only"],
  artifacts: [["applicationDiskImage", "Mochi.dmg"]].map(
    ([role, filename]) => ({
      role: role as SiteRelease["artifacts"][number]["role"],
      filename: filename!,
      sizeBytes: 344_000_000,
      sha256: "0".repeat(64),
      url: `${prefix}${filename}`,
    }),
  ),
  notesUrl: `${prefix}RELEASE_NOTES.md`,
  checksumsUrl: `${prefix}SHA256SUMS.txt`,
};
const site: SiteContext = {
  publication: {
    publisherName: "Fixture only",
    downloadPageUrl: "https://mochi-product.tld/download/",
    supportUrl: "https://mochi-product.tld/support/",
    privacyContactEmail: "privacy@mochi-product.tld",
  },
  release,
  indexable: true,
  documents: { guide: "", privacy: "" },
};

describe("accepted website downloads", () => {
  test("uses a native disk-image link, exact support facts and in-app uninstall instructions", () => {
    const html = renderToStaticMarkup(
      <>
        <ReleaseDownload release={release} />
        <ReleaseFiles release={release} />
      </>,
    );
    expect(html).toContain(`href="${prefix}Mochi.dmg"`);
    expect(html).not.toContain(`href="${prefix}Mochi.pkg"`);
    expect(html).toContain("Apple 芯片 Mac");
    expect(html).toContain("macOS 14.0");
    expect(html).not.toContain("Intel Mac");
    expect(html).not.toContain("download=");
    expect(html).not.toContain('role="button"');
    expect(html).toContain("默认保留本机数据");
    expect(html).toContain("关于与更新");
    expect(html).toContain("永久删除");
    expect(html).toContain(`href="${release.checksumsUrl}"`);
    expect(html).toContain(release.limitations[0]!);
    expect(html).not.toContain("公开测试版");
  });

  test("a public beta names itself and says how its next version arrives", () => {
    const beta: SiteRelease = { ...release, channel: "public-beta" };
    const html = renderToStaticMarkup(<ReleaseDownload release={beta} />);
    expect(html).toContain(`href="${prefix}Mochi.dmg"`);
    expect(html).toContain("公开测试版");
    expect(html).toContain("应用内更新还没有开放");
    expect(html).toContain("卸载并保留数据");
    expect(html).toContain("不要直接拖进「应用程序」覆盖旧版");
    expect(releaseName(beta)).toBe("Mochi 0.2.0 公开测试版");
    expect(releaseName(release)).toBe("Mochi 0.2.0");
    const page: PageMetadata = {
      path: "/download/",
      name: "申请内测",
      title: "申请内测",
      description: "内测",
      indexed: true,
    };
    const head = pageHead(
      page,
      { ...site, release: beta },
      {
        favicon48: "/48.png",
        favicon96: "/96.png",
        touchIcon: "/touch.png",
        shareImage: "/og.png",
      },
    );
    expect(head).toContain("下载 Mochi 0.2.0 公开测试版");
  });

  test("beta builds retain the application entry instead of advertising a file", () => {
    const render = (release: SiteRelease | null) =>
      renderToStaticMarkup(
        <SiteProvider value={{ ...site, release }}>
          <DownloadAction />
        </SiteProvider>,
      );
    expect(render(null)).toContain("申请内测");
    expect(render(null)).not.toContain("下载 Mochi");
    expect(render(release)).toContain("下载 Mochi");
    expect(render(release)).not.toContain("申请内测");
  });

  test("requirements name the beta's Mac and system, then the release's own", () => {
    const [beta] = needs(null);
    expect(beta).toContain("Apple 芯片 Mac");
    expect(beta).toContain(`macOS ${MINIMUM_MACOS_VERSION} `);
    const [accepted] = needs({
      ...release,
      architecture: "x86_64",
      minimumMacOS: "15.0",
    });
    expect(accepted).toContain("Intel Mac");
    expect(accepted).toContain("macOS 15.0 ");
  });

  test("title, share card and breadcrumb match the available download", () => {
    const page: PageMetadata = {
      path: "/download/",
      name: "申请内测",
      title: "申请内测 · Mochi 麻薯",
      description: "内测",
      indexed: true,
    };
    const assets = {
      favicon48: "/48.png",
      favicon96: "/96.png",
      touchIcon: "/touch.png",
      shareImage: "/og.png",
    };
    const head = pageHead(page, site, assets);
    expect(head).toContain("下载 Mochi 0.2.0");
    expect(head).toContain('"name":"下载 Mochi"');
    expect(head).toContain("Apple 芯片 Mac");
    expect(head).not.toContain("申请内测");
    expect(pageHead(page, { ...site, release: null }, assets)).toContain(
      "申请内测",
    );
  });
});
