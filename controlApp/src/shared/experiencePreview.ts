import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { DesktopSurface } from "./experience.ts";
import type { PreviewRequest } from "./model.ts";

/** Review navigation, not the product's setup state machine. No provider inputs. */
export const EXPERIENCE_SCENES = {
  encounter: { label: "完整桌面出场", surface: "encounter" },
  peek: { label: "探头 → 起跳", surface: "encounter" },
  jump: { label: "起跳 → 落框", surface: "encounter" },
  landing: { label: "落框 → 演示", surface: "encounter" },
  intro: { label: "全幅叙事", surface: "intro" },
  location: { label: "移入应用程序", surface: "setup" },
  install: { label: "准备后台", surface: "setup" },
  checking: { label: "确认账号", surface: "setup" },
  signIn: { label: "连接 ChatGPT", surface: "setup" },
  signingIn: { label: "等待 ChatGPT 授权", surface: "setup" },
  ready: { label: "开始值班前", surface: "setup" },
  initializing: { label: "正在安顿工作台", surface: "setup" },
  feishu: { label: "连接飞书", surface: "setup" },
  feishuScan: { label: "飞书扫码", surface: "setup" },
  feishuChecking: { label: "核对飞书机器人", surface: "setup" },
  feishuReady: { label: "确认飞书机器人", surface: "setup" },
  feishuFailure: { label: "飞书待补权限", surface: "setup" },
  github: { label: "连接 GitHub", surface: "setup" },
  githubAuthorizing: { label: "等待 GitHub 授权", surface: "setup" },
  projects: { label: "选择项目", surface: "setup" },
  emptyGroups: { label: "邀请进群", surface: "setup" },
  complete: { label: "准备完成 → 值班台", surface: "setup" },
  companion: { label: "日常值班台", surface: "companion" },
} as const satisfies Record<string, { label: string; surface: DesktopSurface }>;
export type ExperienceScene = keyof typeof EXPERIENCE_SCENES;
export const experienceSceneIds = Object.keys(
  EXPERIENCE_SCENES,
) as ExperienceScene[];
const commandSchema = Type.Enum([
  ...experienceSceneIds,
  "previous",
  "next",
  "replay",
]);
export type ExperiencePreviewCommand = Static<typeof commandSchema>;
const validator = Compile(commandSchema);
export function parseExperiencePreviewCommand(
  value: unknown,
): ExperiencePreviewCommand {
  if (!validator.Check(value))
    throw new Error("Invalid experience preview command");
  return value;
}
export interface ExperiencePreview {
  scene: ExperienceScene;
  nonce: string;
}
export type PresentationPreview =
  | { kind: "motion"; request: NonNullable<PreviewRequest> }
  | { kind: "experience"; request: ExperiencePreview }
  | null;

export function previewDestination(
  command: ExperiencePreviewCommand,
  current: ExperienceScene | null,
): ExperienceScene {
  if (command === "replay") return current ?? "encounter";
  if (command === "next" || command === "previous") {
    const index = current ? experienceSceneIds.indexOf(current) : 0;
    return experienceSceneIds[
      Math.max(
        0,
        Math.min(
          experienceSceneIds.length - 1,
          index + (command === "next" ? 1 : -1),
        ),
      )
    ]!;
  }
  return command;
}
