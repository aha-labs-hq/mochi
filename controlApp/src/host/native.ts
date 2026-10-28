import {
  closeSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as Utils from "electrobun/main/utils";
import { fail } from "../shared/problem.ts";
import type { AppKit } from "./appKit.ts";
import type { ByokPromptInitial } from "./byokPrompt.ts";
import type { DesktopEnvironment } from "./contract.ts";
import type { NativeActions } from "./controller.ts";

export function nativeActions(
  env: DesktopEnvironment,
  kit: AppKit,
): NativeActions {
  return {
    backgroundStatus: () => kit.backgroundStatus(env.plistPath),
    openLoginItems: () => kit.openLoginItems(),
    async confirm(action, affectedBots = []) {
      if (action === "disconnectFeishu")
        return kit.confirm(
          "断开飞书？",
          "这台 Mac 会停止回应当前伙伴的群聊。共享记忆保留，飞书上的应用不会被删除。",
          "断开连接",
        );
      if (action === "discardFeishuCandidate")
        return kit.confirm(
          "放弃这次连接？",
          "已创建的飞书应用会保留，不会自动删除。之后可以重新连接一个飞书机器人，当前已连接的不变。",
          "放弃这次连接",
        );
      if (action === "activateFeishuConnection")
        return kit.confirm(
          "使用这个飞书机器人？",
          "之后的消息将由新的飞书机器人接收。长期记忆保留，各群的选择仍按所属伙伴保存。",
          "使用这个机器人",
        );
      if (action === "disconnectGitHub")
        return kit.confirm(
          "断开 GitHub？",
          "这位伙伴会移除自己的 GitHub 登录与项目选择。待确认的 Issue 操作将失效，聊天记忆仍会保留。GitHub 上的 App 授权不会被自动卸载。",
          "断开连接",
        );
      if (action === "disconnectFeishuMail")
        return kit.confirm(
          "断开飞书邮箱授权？",
          "这位伙伴会停止读取共享邮箱，并清除已选择的邮箱。Mochi 会请飞书撤销这份只读授权；邮箱里的邮件不会被改动。",
          "断开授权",
        );
      if (action === "disconnectByok")
        return kit.confirm(
          "断开模型 API 连接？",
          "所有伙伴会暂停接收新消息，这个模型 API 会从这台 Mac 的运行时中移除。工作记录与其他连接保留。",
          "断开连接",
        );
      return kit.confirm(
        action === "logout" ? "退出 ChatGPT？" : "切换 ChatGPT 账号？",
        `所有伙伴会暂停接收新消息，重新连接后继续各自的工作记录。记忆、嘱咐与模型选择保留。${affectedBots.length ? `\n\n使用此连接：${affectedBots.slice(0, 3).join("、")}${affectedBots.length > 3 ? `等 ${affectedBots.length} 位伙伴` : ""}` : ""}`,
        action === "logout" ? "退出登录" : "切换账号",
      );
    },
    openExternal: (url) => Utils.openExternal(url),
    copyText: (text) => Utils.clipboardWriteText(text),
    openApplications: () => {
      if (!Utils.openPath("/Applications"))
        fail("application_location_invalid");
    },
    promptByok: (submit, initial?: ByokPromptInitial) =>
      kit.promptByok(submit, initial),
    async exportDiagnostics(report) {
      const path = await kit
        .chooseDiagnosticsDestination()
        .catch(() =>
          fail("diagnostics_export_failed", "save_panel_unavailable"),
        );
      if (!path) return;
      if (!path.startsWith("/") || path.includes("\n"))
        fail("diagnostics_export_failed", "destination_invalid");
      const temporary = join(
        dirname(path),
        `.mochi-diagnostics-${crypto.randomUUID()}`,
      );
      let fd: number | undefined;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, path);
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temporary);
        } catch {
          /* An uncreated temporary has nothing to remove. */
        }
        // The errno says why (no permission, disk full) without naming the path.
        fail("diagnostics_export_failed", errnoCode(error));
      }
    },
  };
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,31}$/.test(code)
    ? code
    : "write_failed";
}
