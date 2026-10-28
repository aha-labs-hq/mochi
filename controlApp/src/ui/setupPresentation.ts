import { isByokAccountSummary, parseModelReference } from "../shared/bridge.ts";
import { githubProjectsOf, githubStatusOf } from "../shared/connectorView.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { chatServiceName, companionName, zh } from "../shared/vocabulary.ts";
import { feishuPresentation } from "./FeishuConnection.tsx";

export interface SetupPresentation {
  id: string;
  title: string;
  detail: string;
  note: string;
  /** What the customer brings to setup, named before anything is installed. */
  checklist?: readonly { title: string; detail: string }[];
  action: { label: string; value: DesktopAction } | null;
}

/** Copy projects facts, never timers, inferred credentials or synthetic completion. */
export function setupPresentation(
  snapshot: DesktopSnapshot,
): SetupPresentation {
  const name = companionName(snapshot);
  const service = chatServiceName(snapshot);
  switch (snapshot.setup) {
    case "install":
      return snapshot.locationReady
        ? {
            id: "welcome",
            title: zh`让${name}在这台 Mac 上工作`,
            detail:
              "先准备这台 Mac，再连接团队使用的账号与项目。安装时，macOS 会请求一次管理员授权。",
            note: "开始前准备好这四样：",
            checklist: [
              { title: "模型账号", detail: "ChatGPT 订阅，或一个模型 API" },
              { title: "飞书或 Lark", detail: "可能需要管理员批准一次" },
              { title: "GitHub 项目", detail: "选好要读的项目" },
              { title: "这台 Mac", detail: "保持开机、联网" },
            ],
            action: { label: "安装并继续", value: { type: "prepare" } },
          }
        : {
            id: "location",
            title: "先移到“应用程序”",
            detail:
              "在下载的磁盘映像中，把 Mochi 拖到“应用程序”，再从那里打开，继续完成设置。",
            note: "现在还不会请求管理员授权。",
            action: {
              label: "打开“应用程序”",
              value: { type: "openApplications" },
            },
          };
    case "checking":
      return {
        id: "checking",
        title: "正在检查模型连接",
        detail: "正在读取连接状态。还不用重新连接。",
        note: "已连接的账号会继续使用，无需重复授权。",
        action: null,
      };
    case "signIn":
      return {
        id: "signIn",
        title: "连接模型",
        detail: "使用 ChatGPT 订阅，或添加一个或多个模型 API 连接。",
        note: "模型 API 由服务商单独计费，密钥只保存在这台 Mac 上。",
        action: { label: "连接 ChatGPT", value: { type: "login" } },
      };
    case "signingIn":
      return {
        id: "signingIn",
        title: "在浏览器完成 ChatGPT 授权",
        detail: "授权完成后，Mochi 会自动显示连接结果。",
        note: snapshot.canReopenLogin
          ? "如果授权页没有打开，点击“重新打开浏览器”继续这次登录。"
          : "正在等待浏览器返回授权结果。",
        action: snapshot.canReopenLogin
          ? { label: "重新打开浏览器", value: { type: "reopenLogin" } }
          : null,
      };
    case "initializing":
      return {
        id: "initializing",
        title: "正在启动",
        detail: zh`${name}正在为第一次值班做准备。`,
        note: "完成后会自动开始值班。",
        action: null,
      };
    case "ready":
    case null: {
      if (
        snapshot.feishu.active?.state !== "ready" ||
        snapshot.feishu.candidate
      ) {
        return {
          id: "feishu",
          ...feishuPresentation(snapshot),
        };
      }
      // The first scan creates the Bot from the template policy, whose model may
      // belong to a connection this Mac does not have. Choosing the model
      // follows Feishu, so a policy check never replaces a QR mid-scan.
      if (
        snapshot.account.status === "signedIn" &&
        snapshot.policy &&
        (() => {
          const reference = parseModelReference(snapshot.policy.model);
          const connection = (
            snapshot.account.connections ?? [snapshot.account.account]
          ).find((candidate) => candidate.provider === reference.provider);
          return (
            !connection ||
            (isByokAccountSummary(connection) &&
              snapshot.policy.model !== connection.model)
          );
        })()
      )
        return {
          id: "model",
          title: zh`选择${name}使用的模型`,
          detail:
            "连接已就绪。在设置窗口里选好当前可用的模型和思考深度，这里会自动继续。",
          note: "已有工作记录会继续保留。",
          action: null,
        };
      // Onboarding reads the same derived view every other screen uses, so the
      // first-run copy cannot disagree with what settings later shows.
      const githubStatus = githubStatusOf(snapshot.connectorCatalog);
      // A selected project, not merely an authorized one: the catalog lists
      // every repository the connection can reach, so counting them all would
      // declare setup finished before anything was chosen.
      const hasSelectedProjects = githubProjectsOf(
        snapshot.connectorCatalog,
      ).some((project) => project.selected);
      if (githubStatus !== "connected" || !hasSelectedProjects) {
        return {
          id: "projects",
          title:
            githubStatus === "authorizing"
              ? "在 GitHub 完成授权"
              : githubStatus === "reauthorization_required"
                ? "重新授权 GitHub"
                : githubStatus === "connected"
                  ? "选择 GitHub 项目"
                  : "连接 GitHub",
          detail:
            githubStatus === "authorizing"
              ? zh`授权完成后，回到这里选择${name}可以访问的项目。`
              : githubStatus === "reauthorization_required"
                ? "原有 GitHub 授权已失效，重新授权后即可继续使用已保存的项目范围。"
                : githubStatus === "connected"
                  ? zh`勾选并保存后，${name}才能访问这些项目。`
                  : zh`让${name}通过项目里的文档、代码、Issue 和 PR，了解团队的决定与进展。`,
          note: "只访问你选中的项目。不会修改代码、PR 或工作流；Issue 变更在 GitHub 显示由 Mochi App 执行，并保留谁提出和确认的记录。",
          action: null,
        };
      }
      const bot = snapshot.bots.find(
        (entry) => entry.botId === snapshot.selectedBotId,
      );
      if (bot && (snapshot.setup === "ready" || !bot.enabled)) {
        return {
          id: "ready",
          title: "可以开始值班了",
          detail: zh`开始后，${name}会在已开启回应的群里接收问题。`,
          note: "随时可以暂停，之后再接着聊。",
          action: {
            label: "开始值班",
            value: { type: "setBotEnabled", botId: bot.botId, enabled: true },
          },
        };
      }
      const botName = snapshot.feishu.active.bot!.name;
      const groups = snapshot.feishuGroups;
      const connected =
        snapshot.controlReady &&
        snapshot.eventStreamReady &&
        snapshot.account.status === "signedIn";
      const enabled = groups?.some((group) => group.enabled) === true;
      return {
        id: connected && groups !== null ? "groups" : "connecting",
        title: !connected
          ? zh`正在确认${service}连接`
          : groups === null
            ? "正在读取群聊"
            : groups.length === 0
              ? "把机器人加入群聊"
              : !enabled
                ? "选择一个群，开启回应"
                : zh`去${service}，问第一个问题`,
        detail: !connected
          ? "正在确认是否可以接收群消息。"
          : groups === null
            ? "连接已建立，正在确认所在群；确认前暂时不会接下新消息。"
            : groups.length === 0
              ? zh`在${service}群的机器人设置里添加「${botName}」。加入后，群会出现在这里。`
              : !enabled
                ? zh`所有群都暂停了回应。在管理群聊中开启后，${name}就能接收那个群里的消息。`
                : `在已开启的群里 @${botName}，问一个真正想知道的问题。`,
        note: enabled
          ? "问你们项目的功能和进展，或把讨论整理成 Issue。"
          : "开启哪个群，就从哪里开始。随时可以调整。",
        // Mochi keeps the group list current; an invitation appears on its own.
        action: null,
      };
    }
  }
}
