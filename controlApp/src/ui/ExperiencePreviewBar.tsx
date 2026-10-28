import {
  EXPERIENCE_SCENES,
  type ExperiencePreview,
  type ExperiencePreviewCommand,
  experienceSceneIds,
} from "../shared/experiencePreview.ts";

export function ExperiencePreviewBar({
  preview,
  navigate,
  end,
}: {
  preview: ExperiencePreview;
  navigate(command: ExperiencePreviewCommand): void;
  end(): void;
}) {
  const index = experienceSceneIds.indexOf(preview.scene);
  return (
    <aside
      aria-label="体验预览控制"
      className="absolute inset-x-2 bottom-2 z-50 flex h-9 items-center gap-1 rounded-xl border border-white/20 bg-scrim/90 px-2 text-xs text-inverse shadow-lg backdrop-blur-xl reduced-transparency:bg-scrim [&>button]:shrink-0 [&>button]:cursor-pointer [&>button]:rounded-md [&>button]:px-2 [&>button]:py-1 [&>button]:hover:bg-white/15 [&>button]:disabled:cursor-default [&>button]:disabled:opacity-30 [&>button]:outline-none [&>button]:focus-visible:bg-white/20"
    >
      <span
        className="min-w-0 flex-1 truncate"
        title={`仅演示，不连接或保存 · ${EXPERIENCE_SCENES[preview.scene].label}`}
      >
        仅预览 · 不连接、不保存 · {index + 1}/{experienceSceneIds.length} ·{" "}
        {EXPERIENCE_SCENES[preview.scene].label}
      </span>
      <button
        type="button"
        aria-label="上一环节"
        disabled={index === 0}
        onClick={() => navigate("previous")}
      >
        ←
      </button>
      <button type="button" onClick={() => navigate("replay")}>
        重播
      </button>
      <button
        type="button"
        aria-label="下一环节"
        disabled={index === experienceSceneIds.length - 1}
        onClick={() => navigate("next")}
      >
        →
      </button>
      <button type="button" onClick={end}>
        退出预览
      </button>
    </aside>
  );
}
