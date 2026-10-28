import { unwatchFile, watchFile } from "node:fs";
import QRCode from "qrcode";
import type {
  InstructionDocument,
  InstructionsRequest,
} from "../../../src/agent/instructionDocument.ts";
import type { SkillDocument } from "../../../src/agent/skillCatalog.ts";
import {
  MOCHI_CONTROL_PROTOCOL_VERSION,
  type MochiControlRequest,
  type MochiControlResponse,
} from "../../../src/control/protocol.ts";
import {
  type BotStatus,
  chatGPTLoginPending,
} from "../../../src/control/statusSnapshot.ts";
import { GITHUB_INTEGRATION } from "../../../src/github/integration.ts";
import { LARK_PLATFORMS } from "../../../src/lark/platform.ts";
import { log } from "../../../src/log.ts";
import {
  type ByokConnectionInput,
  parseByokConnection,
} from "../../../src/runtime/byok.ts";
import type { RuntimeModelOption } from "../../../src/runtime/protocol.ts";
import {
  githubRepositoryIdsForResourceIds,
  githubSelectedResourceIds,
  githubStatusOf,
} from "../shared/connectorView.ts";
import {
  type DesktopAction,
  type DesktopSnapshot,
  initialSnapshot,
  type Result,
} from "../shared/model.ts";
import {
  DesktopFailure,
  type DesktopProblem,
  fail,
  problem,
  projectFailure,
  reconcileActionProblem,
} from "../shared/problem.ts";
import { initialUpdateView, type UpdateView } from "../shared/updates.ts";
import {
  type ByokPromptInitial,
  type ByokPromptProblem,
  byokPromptProblem,
} from "./byokPrompt.ts";
import { type DesktopEnvironment, locationReady } from "./contract.ts";
import { sendControl } from "./control.ts";
import {
  ActivityReader,
  diagnosticsReport,
  recentDiagnosticEvents,
} from "./diagnostics.ts";
import { projectFleet } from "./fleet.ts";
import { prepareProduct } from "./installer.ts";
import { DesktopService } from "./service.ts";
import type { DesktopUpdates } from "./updates.ts";

export interface NativeActions {
  backgroundStatus(): number;
  openLoginItems(): void;
  confirm(
    action:
      | "logout"
      | "disconnectByok"
      | "switchAccount"
      | "disconnectGitHub"
      | "disconnectFeishu"
      | "disconnectFeishuMail"
      | "discardFeishuCandidate"
      | "activateFeishuConnection",
    affectedBots?: readonly string[],
  ): Promise<boolean>;
  openExternal(url: string): boolean;
  /** Places text on the system pasteboard; the renderer never receives it. */
  copyText(text: string): void;
  openApplications(): void;
  promptByok(
    submit: (input: ByokConnectionInput) => Promise<ByokPromptProblem | null>,
    initial?: ByokPromptInitial,
  ): Promise<void>;
  exportDiagnostics(report: object): Promise<void>;
}

/** Owns observation and serialization, not Bridge business policy or installation transactions. */
export class DesktopController {
  snapshot: DesktopSnapshot;
  private actionProblem: DesktopProblem | null = null;
  private readonly authorizations = new Map<
    string,
    {
      github: string | null;
      feishu: { url: string; qr: string } | null;
      feishuMail: { url: string; qr: string } | null;
    }
  >();
  private authorizationFor(botId = this.snapshot.selectedBotId) {
    if (!botId) fail("bot_unknown");
    let entry = this.authorizations.get(botId);
    if (!entry) {
      entry = { github: null, feishu: null, feishuMail: null };
      this.authorizations.set(botId, entry);
    }
    return entry;
  }
  private authorizationUrl: string | null = null;
  private get githubAuthorizationUrl() {
    return this.snapshot.selectedBotId ? this.authorizationFor().github : null;
  }
  private set githubAuthorizationUrl(value: string | null) {
    if (this.snapshot.selectedBotId) this.authorizationFor().github = value;
  }
  private get feishuAuthorization() {
    return this.snapshot.selectedBotId ? this.authorizationFor().feishu : null;
  }
  private set feishuAuthorization(value: { url: string; qr: string } | null) {
    if (this.snapshot.selectedBotId) this.authorizationFor().feishu = value;
  }
  private get feishuMailAuthorization() {
    return this.snapshot.selectedBotId
      ? this.authorizationFor().feishuMail
      : null;
  }
  private set feishuMailAuthorization(value: {
    url: string;
    qr: string;
  } | null) {
    if (this.snapshot.selectedBotId) this.authorizationFor().feishuMail = value;
  }
  private observation: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private unobserve: (() => void) | undefined;
  private refreshAgain = false;
  private listeners = new Set<(snapshot: DesktopSnapshot) => void>();
  private activeOperation: Promise<void> | null = null;
  private shutdownTask: Promise<Result<null>> | null = null;
  private quitting = false;
  private readonly activity = new ActivityReader();
  constructor(
    readonly env: DesktopEnvironment,
    private readonly native: NativeActions,
    private readonly service: Pick<
      DesktopService,
      "inspect" | "perform" | "requireControl"
    > = new DesktopService(env, () => native.backgroundStatus()),
    private readonly control = sendControl,
    private readonly prepare = prepareProduct,
  ) {
    this.snapshot = initialSnapshot(
      env.manifest.productVersion,
      env.manifest.serviceMode === "development",
    );
  }
  updates: DesktopUpdates | null = null;
  uninstall: { start(): Promise<void>; cancel(): Promise<void> } | null = null;
  reportUninstallFailure(): void {
    this.actionProblem = problem("product_uninstall_failed");
    this.publish({ ...this.snapshot, problem: this.actionProblem });
  }
  private updateView = initialUpdateView();
  publishUpdate(view: UpdateView): void {
    this.updateView = view;
    this.publish({ ...this.snapshot, update: view });
  }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): void {
    if (this.unobserve) throw new Error("Desktop observation already started");
    const paths = [this.env.statusPath, this.env.plistPath, this.env.logPath];
    const changed = () => {
      void this.refresh();
    };
    // Stat observation survives atomic file replacement and initially absent directories.
    // No launchctl process is spawned for unchanged metadata.
    for (const path of paths)
      watchFile(path, { interval: 1000, persistent: false }, changed);
    this.unobserve = () => {
      for (const path of paths) unwatchFile(path, changed);
    };
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 15_000);
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.expiry);
    this.unobserve?.();
    this.unobserve = undefined;
  }
  shutdown(): Promise<Result<null>> {
    if (this.shutdownTask) return this.shutdownTask;
    this.quitting = true;
    this.shutdownTask = (async () => {
      await this.activeOperation;
      const result = await this.performExclusive("shutdown", async () => {
        // A DMG/download copy does not own the installed deployment's service.
        if (locationReady(this.env)) await this.service.perform("stop");
        return null;
      });
      if (result.ok) this.stop();
      else this.quitting = false;
      return result;
    })().finally(() => {
      this.shutdownTask = null;
    });
    return this.shutdownTask;
  }
  refresh(): Promise<void> {
    if (this.observation) {
      this.refreshAgain = true;
      return this.observation;
    }
    this.observation = (async () => {
      do {
        this.refreshAgain = false;
        await this.observe();
      } while (this.refreshAgain);
    })().finally(() => {
      this.observation = null;
    });
    return this.observation;
  }
  private async observe(): Promise<void> {
    let next = {
      ...initialSnapshot(
        this.env.manifest.productVersion,
        this.snapshot.development,
      ),
      busy: this.snapshot.busy,
    };
    try {
      next.locationReady = locationReady(this.env);
      if (!next.locationReady) {
        next.phase = "notInstalled";
        next.setup = "install";
      } else {
        const evidence = await this.service.inspect();
        clearTimeout(this.expiry);
        if (this.unobserve && evidence.status)
          this.expiry = setTimeout(
            () => {
              void this.refresh();
            },
            Math.max(
              1,
              Date.parse(evidence.status.validUntil) - Date.now() + 1,
            ),
          );
        next.installed = evidence.installed;
        next.loaded = evidence.launch !== null;
        next.phase = !evidence.installed
          ? "notInstalled"
          : evidence.launch
            ? "starting"
            : "stopped";
        next.setup =
          !evidence.installed && !next.development ? "install" : null;
        if (evidence.status)
          next = projectFleet(next, evidence.status, this.selectedBotId());
        next.problem = evidence.problem;
        if (next.problem && !evidence.status) next.phase = "attention";
        next.activity = this.activity.read(this.env.logPath);
      }
    } catch (error) {
      next.phase = "attention";
      next.problem = projectFailure(error, "service_operation_failed");
    }
    const authorization = next.selectedBotId
      ? this.authorizationFor(next.selectedBotId)
      : null;
    if (!chatGPTLoginPending(next.account) && next.account.status !== "unknown")
      this.authorizationUrl = null;
    if (authorization) {
      const githubStatus = githubStatusOf(next.connectorCatalog);
      if (githubStatus !== "authorizing" && githubStatus !== "unavailable") {
        authorization.github = null;
      }
      if (
        next.feishu.candidate &&
        next.feishu.candidate.state !== "registering"
      )
        authorization.feishu = null;
      const mail = next.connectorCatalog?.connections.find(
        (connection) => connection.providerId === "feishu-mail",
      );
      // The code is only useful while the Bridge is still waiting for it.
      if (mail?.status !== "authorizing") authorization.feishuMail = null;
    }
    next.canReopenLogin = this.authorizationUrl !== null;
    next.canReopenGitHubLogin = authorization?.github != null;
    next.canReopenFeishuConnection = authorization?.feishu != null;
    next.feishuVerificationQr = authorization?.feishu?.qr ?? null;
    next.canReopenFeishuMailAuthorization = authorization?.feishuMail != null;
    next.feishuMailVerificationQr = authorization?.feishuMail?.qr ?? null;
    this.actionProblem = reconcileActionProblem(this.actionProblem, next);
    next.problem = this.actionProblem ?? next.problem;
    // An observation may have started before an action acquired the gate.
    next.busy = this.snapshot.busy;
    this.publish(next);
  }
  private publish(next: DesktopSnapshot): void {
    next = { ...next, update: this.updateView };
    if (JSON.stringify(this.snapshot) === JSON.stringify(next)) return;
    if (
      this.snapshot.phase !== next.phase ||
      this.snapshot.problem?.code !== next.problem?.code
    ) {
      log.info("state.changed", {
        phase: next.phase,
        problem: next.problem?.code ?? "none",
        deployment: this.env.manifest.serviceMode,
      });
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
  }
  async instructions(
    input: InstructionsRequest,
  ): Promise<Result<InstructionDocument>> {
    return this.performExclusive("instructions", async () => {
      const response = await this.request(
        input.type === "read"
          ? {
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "read_instructions",
              botId: await this.requiredBotId(),
            }
          : {
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "save_instructions",
              botId: await this.requiredBotId(),
              document: input.document,
            },
      );
      return response.document!;
    });
  }
  async skills(): Promise<Result<readonly SkillDocument[]>> {
    return this.performExclusive(
      "skills",
      async () =>
        (
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "read_skills",
            botId: await this.requiredBotId(),
          })
        ).skills!,
    );
  }
  async schedules(): Promise<
    Result<readonly import("../../../src/schedules/view.ts").ScheduleView[]>
  > {
    return this.performExclusive(
      "schedules",
      async () =>
        (
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "read_schedules",
            botId: await this.requiredBotId(),
          })
        ).schedules!,
    );
  }
  async models(): Promise<Result<readonly RuntimeModelOption[]>> {
    return this.performExclusive(
      "models",
      async () =>
        (
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "model_catalog",
            botId: await this.requiredBotId(),
          })
        ).models!,
    );
  }
  /**
   * Someone just returned to Mochi: asks the selected Bot to recheck its
   * connections. Never exclusive and never busy, so nothing on screen dims or
   * waits; the Bot answers at once, rechecks in the background and publishes
   * only what changed.
   */
  async recheck(): Promise<void> {
    const botId = this.snapshot.selectedBotId;
    if (!botId || !this.snapshot.controlReady || this.quitting) return;
    try {
      await this.request({
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        command: "recheck_connections",
        botId,
      });
    } catch (error) {
      log.warn("connections.recheck_failed", {
        problem: projectFailure(error, "control_unavailable").code,
      });
    }
  }
  async perform(action: DesktopAction): Promise<Result<null>> {
    if (action.type === "cancelUninstall") {
      if (this.snapshot.busy !== "uninstall" || !this.uninstall)
        return { ok: false, problem: problem("action_in_progress") };
      try {
        await this.uninstall.cancel();
        return { ok: true, value: null };
      } catch {
        return { ok: false, problem: problem("product_uninstall_failed") };
      }
    }
    if (
      action.type === "checkUpdate" ||
      action.type === "downloadUpdate" ||
      action.type === "pauseUpdate" ||
      action.type === "installUpdate" ||
      action.type === "cancelUpdate" ||
      action.type === "retryUpdate" ||
      action.type === "setUpdatePreferences"
    ) {
      if (
        !this.updates ||
        this.snapshot.busy === "uninstall" ||
        this.quitting ||
        (this.snapshot.busy &&
          ["installUpdate", "retryUpdate"].includes(action.type))
      )
        return { ok: false, problem: problem("action_in_progress") };
      switch (action.type) {
        case "checkUpdate":
          void this.updates.check();
          break;
        case "downloadUpdate":
          void this.updates.download();
          break;
        case "pauseUpdate":
          this.updates.pause();
          break;
        case "installUpdate":
          void this.updates.install();
          break;
        case "cancelUpdate":
          await this.updates.cancel();
          break;
        case "retryUpdate":
          void this.updates.retry();
          break;
        case "setUpdatePreferences":
          await this.updates.preferences(action.preferences);
          break;
      }
      return { ok: true, value: null };
    }
    const report =
      action.type === "exportDiagnostics"
        ? diagnosticsReport(
            this.snapshot,
            this.env.manifest,
            recentDiagnosticEvents([
              this.env.logPath,
              this.env.companionLogPath,
            ]),
          )
        : null;
    return this.performExclusive(action.type, async () => {
      // Selecting a Bot only changes what the windows describe, so it is settled
      // before the location gate: a customer must be able to look at their own
      // Bots even while the App is waiting for an install or a repair.
      if (action.type === "selectBot") {
        const roster = await this.service.requireControl();
        if (!roster.bots.some((bot) => bot.botId === action.botId))
          fail("bot_unknown");
        // Every per-Bot fact in the window must describe the newly chosen Bot
        // before the renderer can act on it, so re-project instead of only
        // recording the identity.
        this.publish(projectFleet(this.snapshot, roster, action.botId));
        return null;
      }
      if (
        !locationReady(this.env) &&
        !["openApplications", "exportDiagnostics", "clearProblem"].includes(
          action.type,
        )
      )
        fail("application_location_invalid");
      switch (action.type) {
        case "connectFeishu": {
          if (this.snapshot.bots.length === 0) await this.createBot();
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "start_feishu_connection",
            botId: await this.requiredBotId(),
          });
          const url = response.authorizationUrl!;
          this.feishuAuthorization = {
            url,
            qr: await QRCode.toDataURL(url, {
              type: "image/png",
              errorCorrectionLevel: "M",
              margin: 4,
              scale: 6,
            }),
          };
          // QR stays inside Mochi. Opening the official page is a separate user action.
          break;
        }
        case "reopenFeishuConnection":
          if (
            !this.feishuAuthorization ||
            this.snapshot.feishu.candidate?.state !== "registering"
          )
            fail("feishu_connection_failed");
          if (!this.native.openExternal(this.feishuAuthorization.url))
            fail("browser_unavailable");
          break;
        case "cancelFeishuConnection":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "cancel_feishu_connection",
            botId: await this.requiredBotId(),
          });
          break;
        case "openFeishuGroup": {
          const current = await this.selectedBotStatus();
          if (
            current.feishu.active?.state !== "ready" ||
            !current.feishuGroups?.some((group) => group.id === action.chatId)
          )
            fail("group_inventory_unavailable");
          // Official joined-chat AppLink; the renderer cannot supply a URL or message.
          if (
            !this.native.openExternal(
              `${LARK_PLATFORMS[current.feishu.active.brand].appLink}/client/chat/open?${new URLSearchParams({ openChatId: action.chatId })}`,
            )
          )
            fail("browser_unavailable");
          break;
        }
        case "checkFeishuCandidate":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "check_feishu_candidate",
            botId: await this.requiredBotId(),
          });
          break;
        case "activateFeishuConnection":
          if (
            this.snapshot.feishu.active &&
            !(await this.native.confirm("activateFeishuConnection"))
          )
            break;
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "activate_feishu_connection",
            botId: await this.requiredBotId(),
          });
          if ((await this.selectedBotStatus()).feishu.active?.state !== "ready")
            fail("feishu_connection_failed");
          break;
        case "disconnectFeishu":
          if (await this.native.confirm("disconnectFeishu")) {
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "disconnect_feishu",
              botId: await this.requiredBotId(),
            });
            if ((await this.selectedBotStatus()).feishu.active !== null)
              fail("feishu_connection_failed");
          }
          break;
        case "discardFeishuCandidate":
          if (await this.native.confirm("discardFeishuCandidate"))
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "discard_feishu_candidate",
              botId: await this.requiredBotId(),
            });
          break;
        case "feishuSettings": {
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "feishu_settings",
            botId: await this.requiredBotId(),
          });
          if (!this.native.openExternal(response.authorizationUrl!))
            fail("browser_unavailable");
          break;
        }
        case "copyFeishuApprovalLink": {
          // The same official consent page, handed to an administrator by the
          // customer. The URL goes to the pasteboard, never to the renderer.
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "feishu_settings",
            botId: await this.requiredBotId(),
          });
          this.native.copyText(response.authorizationUrl!);
          break;
        }
        case "authorizeFeishuMail": {
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "start_feishu_mail_authorization",
            botId: await this.requiredBotId(),
          });
          const url = response.authorizationUrl!;
          this.feishuMailAuthorization = {
            url,
            qr: await QRCode.toDataURL(url, {
              type: "image/png",
              errorCorrectionLevel: "M",
              margin: 4,
              scale: 6,
            }),
          };
          if (!this.native.openExternal(url)) fail("browser_unavailable");
          break;
        }
        case "reopenFeishuMailAuthorization":
          if (!this.feishuMailAuthorization) fail("feishu_mail_unavailable");
          if (!this.native.openExternal(this.feishuMailAuthorization.url))
            fail("browser_unavailable");
          break;
        case "cancelFeishuMailAuthorization":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "cancel_feishu_mail_authorization",
            botId: await this.requiredBotId(),
          });
          this.feishuMailAuthorization = null;
          break;
        case "disconnectFeishuMail":
          if (await this.native.confirm("disconnectFeishuMail"))
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "disconnect_feishu_mail",
              botId: await this.requiredBotId(),
            });
          break;
        case "feishuMailSettings": {
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "feishu_mail_settings",
            botId: await this.requiredBotId(),
          });
          if (!this.native.openExternal(response.authorizationUrl!))
            fail("browser_unavailable");
          break;
        }
        case "loginGitHub": {
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "start_github_login",
            botId: await this.requiredBotId(),
          });
          this.githubAuthorizationUrl = response.authorizationUrl!;
          if (!this.native.openExternal(this.githubAuthorizationUrl))
            fail("browser_unavailable");
          break;
        }
        case "reopenGitHubLogin":
          if (
            !this.githubAuthorizationUrl ||
            githubStatusOf(this.snapshot.connectorCatalog) !== "authorizing"
          )
            fail("github_connection_failed");
          if (!this.native.openExternal(this.githubAuthorizationUrl))
            fail("browser_unavailable");
          break;
        case "cancelGitHubLogin":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "cancel_github_login",
            botId: await this.requiredBotId(),
          });
          break;
        case "disconnectGitHub":
          if (await this.native.confirm("disconnectGitHub")) {
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "disconnect_github",
              botId: await this.requiredBotId(),
            });
            const status = githubStatusOf(
              (await this.selectedBotStatus()).connectorCatalog,
            );
            if (status !== "disconnected") fail("github_connection_failed");
          }
          break;
        case "selectProjects": {
          const before = (await this.selectedBotStatus()).connectorCatalog;
          const repositoryIds = githubRepositoryIdsForResourceIds(
            before,
            action.resourceIds,
          );
          if (!repositoryIds) fail("github_selection_failed");
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "select_projects",
            botId: await this.requiredBotId(),
            repositoryIds,
          });
          // The readback proves the published catalog now carries exactly these
          // repositories. It compares catalog resource ids rather than a
          // provider-shaped list, so there is one place a selection can be read.
          const catalog = (await this.selectedBotStatus()).connectorCatalog;
          const selected = githubSelectedResourceIds(catalog);
          if (
            githubStatusOf(catalog) !== "connected" ||
            selected.length !== action.resourceIds.length ||
            selected.some((id) => !action.resourceIds.includes(id))
          )
            fail("github_selection_failed");
          break;
        }
        case "addConnectorResources": {
          const previous = (
            await this.selectedBotStatus()
          ).connectorCatalog?.connections.find(
            (candidate) => candidate.connectionId === action.connectionId,
          );
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "add_connector_resources",
            botId: await this.requiredBotId(),
            connectionId: action.connectionId,
            references: action.references,
          });
          const connection = (
            await this.selectedBotStatus()
          ).connectorCatalog?.connections.find(
            (candidate) => candidate.connectionId === action.connectionId,
          );
          // The successful adapter response proves each reference was resolved
          // and read. Readback proves the additive operation preserved every
          // existing choice; duplicates may select nothing new. Unselected
          // options (a provider's proven catalog) carry no authority and may
          // become selections, so only selections are compared.
          if (
            connection?.status !== "ready" ||
            !previous ||
            selectedResources(connection).length >
              selectedResources(previous).length + action.references.length ||
            selectedResources(previous).some(
              (before) => !keepsSelection(connection, before),
            )
          )
            fail("connector_selection_failed");
          break;
        }
        case "removeConnectorResource": {
          const previous = (
            await this.selectedBotStatus()
          ).connectorCatalog?.connections.find(
            (candidate) => candidate.connectionId === action.connectionId,
          );
          if (
            !previous?.resources.some(
              (resource) =>
                resource.resourceId === action.resourceId &&
                resource.selectionId === action.selectionId,
            )
          )
            fail("connector_selection_failed");
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "remove_connector_resource",
            botId: await this.requiredBotId(),
            connectionId: action.connectionId,
            resourceId: action.resourceId,
            selectionId: action.selectionId,
          });
          const connection = (
            await this.selectedBotStatus()
          ).connectorCatalog?.connections.find(
            (candidate) => candidate.connectionId === action.connectionId,
          );
          // The target is no longer selected; a provider with a proven catalog
          // keeps it as an unselected option. Every other choice is unchanged.
          const remaining = selectedResources(previous).filter(
            (resource) => resource.resourceId !== action.resourceId,
          );
          if (
            !connection ||
            connection.status !== previous.status ||
            connection.resources.some(
              (resource) =>
                resource.resourceId === action.resourceId && resource.selected,
            ) ||
            selectedResources(connection).length !== remaining.length ||
            connection.resourceScope.selectedCount !==
              previous.resourceScope.selectedCount - 1 ||
            remaining.some((before) => !keepsSelection(connection, before))
          )
            fail("connector_selection_failed");
          break;
        }
        case "manageGitHubAccess":
          {
            const response = await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "start_github_installation",
              botId: await this.requiredBotId(),
            });
            this.githubAuthorizationUrl = response.authorizationUrl!;
            if (!this.native.openExternal(this.githubAuthorizationUrl))
              fail("browser_unavailable");
          }
          break;
        case "reviewGitHubAuthorization":
          if (
            !this.native.openExternal(
              GITHUB_INTEGRATION.authorizationSettingsUrl,
            )
          )
            fail("browser_unavailable");
          break;
        case "createBot": {
          await this.createBot();
          break;
        }
        case "setBotEnabled":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "set_bot_enabled",
            botId: action.botId,
            enabled: action.enabled,
          });
          if (
            (await this.service.requireControl()).bots.find(
              (bot) => bot.botId === action.botId,
            )?.enabled !== action.enabled
          )
            fail("bot_activation_failed");
          break;
        case "setBotCharacter":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "set_bot_character",
            botId: action.botId,
            characterId: action.characterId,
          });
          if (
            (await this.service.requireControl()).bots.find(
              (bot) => bot.botId === action.botId,
            )?.characterId !== action.characterId
          )
            fail("bot_character_failed");
          break;
        case "renameBot": {
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "rename_bot",
            botId: action.botId,
            label: action.label,
          });
          // The roster is the only authority for a Bot's name, so the new label is
          // read back rather than assumed from what was typed.
          const roster = await this.service.requireControl();
          if (
            roster.bots.find((bot) => bot.botId === action.botId)?.label !==
            action.label
          )
            fail("bot_rename_failed");
          this.publish(
            projectFleet(this.snapshot, roster, this.snapshot.selectedBotId),
          );
          break;
        }
        case "clearProblem":
          break;
        case "openApplications":
          this.native.openApplications();
          break;
        case "openLoginItems":
          this.native.openLoginItems();
          break;
        case "exportDiagnostics":
          await this.native.exportDiagnostics(report!);
          break;
        case "service":
          await this.service.perform(action.operation);
          break;
        case "prepare":
          await this.prepare(this.env);
          break;
        case "uninstall":
          if (this.env.manifest.serviceMode !== "installed" || !this.uninstall)
            fail("component_contract_unavailable");
          await this.uninstall.start();
          break;
        case "reopenLogin":
          if (
            !this.authorizationUrl ||
            !chatGPTLoginPending(this.snapshot.account)
          )
            fail("login_failed");
          if (!this.native.openExternal(this.authorizationUrl))
            fail("login_browser_unavailable");
          break;
        case "login":
        case "switchAccount": {
          if (
            action.type === "switchAccount" &&
            !(await this.native.confirm(
              action.type,
              this.snapshot.bots.map((bot) => bot.label),
            ))
          )
            return null;
          const response = await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command:
              action.type === "login"
                ? "start_chatgpt_login"
                : "switch_chatgpt_account",
          });
          this.authorizationUrl = response.authorizationUrl!;
          if (!this.native.openExternal(this.authorizationUrl))
            fail("login_browser_unavailable");
          break;
        }
        case "configureByok":
        case "configureModelApi": {
          const connectionId =
            action.type === "configureModelApi"
              ? action.connectionId
              : undefined;
          let initial: ByokPromptInitial | undefined;
          if (connectionId !== undefined) {
            const response = await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "read_byok",
            });
            const setup = response.connections?.find(
              (entry) => entry.provider === connectionId,
            );
            if (!setup) fail("account_status_unavailable");
            initial = {
              baseUrl: setup.baseUrl,
              model: setup.model,
              label: setup.label,
            };
          }
          await this.native.promptByok(async (draft) => {
            try {
              const input = parseByokConnection({
                baseUrl: draft.baseUrl.trim(),
                model: draft.model.trim(),
                label: draft.label.trim(),
                apiKey: draft.apiKey.trim(),
              });
              await this.request({
                version: MOCHI_CONTROL_PROTOCOL_VERSION,
                command: "configure_byok",
                ...(connectionId === undefined ? {} : { connectionId }),
                ...input,
              });
              return null;
            } catch (error) {
              return byokPromptProblem(error);
            }
          }, initial);
          break;
        }
        case "removeByok":
        case "removeModelApi":
          if (
            await this.native.confirm(
              "disconnectByok",
              this.snapshot.bots.map((bot) => bot.label),
            )
          )
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "remove_byok",
              ...(action.type === "removeModelApi"
                ? { connectionId: action.connectionId }
                : {}),
            });
          break;
        case "logout":
          if (
            await this.native.confirm(
              "logout",
              this.snapshot.bots.map((bot) => bot.label),
            )
          )
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              command: "logout_chatgpt",
            });
          break;
        case "cancelLogin":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "cancel_chatgpt_login",
          });
          break;
        case "organize":
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "organize_context",
            botId: await this.requiredBotId(),
          });
          break;
        case "recoverBot":
          // Reconnects only the selected Bot; the service and other Bots keep running.
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "recover_bot",
            botId: await this.requiredBotId(),
          });
          break;
        case "updatePolicy": {
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "update_model_policy",
            botId: await this.requiredBotId(),
            ...action.policy,
          });
          const status = await this.selectedBotStatus();
          if (
            status.botPolicy.model !== action.policy.model ||
            status.botPolicy.reasoningEffort !== action.policy.reasoningEffort
          )
            fail("model_policy_out_of_sync");
          break;
        }
        case "updateGroupParticipation": {
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            command: "update_group_participation",
            botId: await this.requiredBotId(),
            chatId: action.chatId,
            enabled: action.enabled,
          });
          const status = await this.selectedBotStatus();
          if (
            status.feishuGroups?.find((group) => group.id === action.chatId)
              ?.enabled !== action.enabled
          )
            fail("group_participation_update_failed");
          break;
        }
        case "setScheduleEnabled":
        case "cancelSchedule": {
          const botId = await this.requiredBotId();
          await this.request({
            version: MOCHI_CONTROL_PROTOCOL_VERSION,
            botId,
            command:
              action.type === "cancelSchedule"
                ? "cancel_schedule"
                : "set_schedule_enabled",
            scheduleId: action.scheduleId,
            revision: action.revision,
            ...(action.type === "setScheduleEnabled"
              ? { enabled: action.enabled }
              : {}),
          } as MochiControlRequest);
          const readback = (
            await this.request({
              version: MOCHI_CONTROL_PROTOCOL_VERSION,
              botId,
              command: "read_schedules",
            })
          ).schedules!;
          const current = readback.find(
            (item) => item.id === action.scheduleId,
          );
          if (
            action.type === "cancelSchedule"
              ? current !== undefined
              : current?.enabled !== action.enabled
          )
            fail("schedules_update_failed");
          break;
        }
        case "cancelUninstall":
        case "checkUpdate":
        case "downloadUpdate":
        case "pauseUpdate":
        case "installUpdate":
        case "cancelUpdate":
        case "retryUpdate":
          throw new Error("Update action was not routed");
        default: {
          const unhandled: never = action;
          throw new Error(`Unknown action: ${unhandled}`);
        }
      }
      return null;
    });
  }
  /**
   * The selected Bot's own published status.
   *
   * A read-back after a Bot-scoped write must describe the Bot that write was
   * sent to, from the same fleet snapshot the renderer sees. Reading the fleet
   * object here would let a write be confirmed against another Bot's facts.
   */
  private async selectedBotStatus(): Promise<BotStatus> {
    const botId = await this.requiredBotId();
    const status = await this.service.requireControl();
    const bot = status.bots.find((candidate) => candidate.botId === botId);
    if (!bot) fail("bot_unknown");
    return bot;
  }

  /**
   * The Bot the customer is looking at.
   *
   * It is remembered across observations, so a heartbeat can never silently move
   * a settings page to another Bot; the renderer's selection is the only input.
   */
  private selectedBotId(): string | null {
    const roster = this.snapshot.bots;
    const selected = this.snapshot.selectedBotId;
    if (!roster.length) return selected;
    return roster.some((bot) => bot.botId === selected) ? selected : null;
  }

  private async createBot(): Promise<void> {
    const response = await this.request({
      version: MOCHI_CONTROL_PROTOCOL_VERSION,
      command: "create_bot",
    });
    const botId = response.botId;
    if (!botId) fail("bot_creation_failed");
    const roster = await this.service.requireControl();
    if (!roster.bots.some((bot) => bot.botId === botId))
      fail("bot_creation_failed");
    this.publish(projectFleet(this.snapshot, roster, botId));
  }

  /** The Bot a Bot-scoped action applies to. Identity is resolved from the roster. */
  private async requiredBotId(): Promise<string> {
    // The roster always comes from a fresh observation, never from a snapshot the
    // first frame may not have carried yet: naming a Bot is an authorization
    // decision, and guessing it from an empty list would fail the customer's first
    // click on every launch.
    if (!this.snapshot.bots.length) await this.refresh();
    const selected = this.selectedBotId();
    if (!selected) fail("bot_unknown");
    return selected;
  }

  private async request(
    request: MochiControlRequest,
  ): Promise<MochiControlResponse> {
    if (!locationReady(this.env)) fail("application_location_invalid");
    await this.service.requireControl();
    return this.control(this.env.socketPath, request);
  }
  private async performExclusive<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<Result<T>> {
    if (this.snapshot.busy || (this.quitting && name !== "shutdown"))
      return { ok: false, problem: problem("action_in_progress") };
    const completed = Promise.withResolvers<void>();
    this.activeOperation = completed.promise;
    this.actionProblem = null;
    this.publish({ ...this.snapshot, busy: name, problem: null });
    log.info("action.started", { action: name });
    try {
      const value = await operation();
      log.info("action.completed", { action: name });
      return { ok: true, value };
    } catch (error) {
      this.actionProblem = projectFailure(error, "service_operation_failed");
      log.warn("action.failed", {
        action: name,
        problem: this.actionProblem.code,
        ...(error instanceof DesktopFailure && error.reason
          ? { reason: error.reason }
          : {}),
      });
      return { ok: false, problem: this.actionProblem };
    } finally {
      // Finish any prior observation before refreshing the post-operation evidence.
      if (this.observation) await this.observation;
      this.publish({
        ...this.snapshot,
        busy: null,
        problem: this.actionProblem,
      });
      try {
        await this.refresh();
      } finally {
        if (this.activeOperation === completed.promise)
          this.activeOperation = null;
        completed.resolve();
      }
    }
  }
}

type CatalogConnection = NonNullable<
  DesktopSnapshot["connectorCatalog"]
>["connections"][number];

function selectedResources(connection: CatalogConnection) {
  return connection.resources.filter((resource) => resource.selected);
}

/** A choice survives a change only with the same resource and selection identity. */
function keepsSelection(
  connection: CatalogConnection,
  before: CatalogConnection["resources"][number],
): boolean {
  return connection.resources.some(
    (after) =>
      after.selected &&
      after.resourceId === before.resourceId &&
      after.selectionId === before.selectionId,
  );
}
