import type { SiteRelease } from "./context.ts";
import { macName } from "./facts.ts";
import { Action } from "./ui.tsx";

export function ReleaseDownload({ release }: { release: SiteRelease }) {
  const diskImage = release.artifacts.find(
    ({ role }) => role === "applicationDiskImage",
  );
  if (!diskImage)
    throw new Error("Accepted release lacks its application disk image");
  const architecture = macName(release.architecture);
  return (
    <div className="mt-10">
      <Action href={diskImage.url} glyph="arrowDown">
        {release.architecture === "arm64"
          ? "下载 Apple 芯片版"
          : "下载 Intel 版"}
      </Action>
      <p className="mt-4 text-small text-muted">
        {architecture} · macOS {release.minimumMacOS} 或更新版本 ·{" "}
        {Math.ceil(diskImage.sizeBytes / 1024 / 1024)} MiB
      </p>
      <p className="mt-4 text-small text-muted">
        打开磁盘映像，把 Mochi 拖进「应用程序」，再打开
        Mochi。首次准备时，按系统提示授权。
      </p>
      {release.channel === "public-beta" && (
        <p className="mt-4 text-small text-muted">
          这是公开测试版，应用内更新还没有开放。新版本会发布在这一页：先在 Mochi
          的“关于与更新”中卸载并保留数据，再安装新版本；不要直接拖进「应用程序」覆盖旧版。
        </p>
      )}
      <a
        href={release.notesUrl}
        className="mt-4 inline-block text-small underline underline-offset-4"
      >
        版本说明与使用边界
      </a>
    </div>
  );
}

export function ReleaseFiles({ release }: { release: SiteRelease }) {
  return (
    <div className="mt-10 pt-8">
      <h2 className="text-[20px] leading-8 font-semibold">这一版的使用边界</h2>
      <ul className="mt-4 list-disc space-y-3 pl-5 text-small text-muted">
        {release.limitations.map((limitation) => (
          <li key={limitation}>{limitation}</li>
        ))}
      </ul>
      <details className="group mt-8 pt-6">
        <summary className="cursor-pointer text-[15px] font-medium">
          卸载与文件校验
        </summary>
        <ul className="mt-6 list-disc space-y-6 pl-5">
          <li className="text-small text-muted">
            在 Mochi 的“关于与更新”中选择“卸载
            Mochi”。默认保留本机数据，也可以明确选择永久删除所有伙伴、连接与工作记忆。只把
            Mochi 拖到废纸篓不会停止后台服务。
          </li>
          <li>
            <a
              href={release.checksumsUrl}
              className="text-small underline underline-offset-4"
            >
              所有文件的 SHA-256 校验值
            </a>
            <p className="mt-2 text-small text-muted">
              用于核对文件是否完整，与你下载的这一版对应。
            </p>
          </li>
        </ul>
      </details>
    </div>
  );
}
