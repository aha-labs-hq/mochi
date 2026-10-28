import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { errorFields, log } from "../log.ts";
import type { RuntimeModelOption } from "../runtime/protocol.ts";
import type { InstructionDocument } from "../agent/instructionDocument.ts";
import type { ScheduleView } from "../schedules/view.ts";
import { ScheduleConflictError, ScheduleExpiredError } from "../schedules/store.ts";
import { InstructionsError } from "../agent/instructionStore.ts";
import { readBuiltinSkills } from "../agent/builtinSkills.ts";
import { ConnectorError, type ConnectorErrorCode } from "../connectors/errors.ts";
import { DEFAULT_BOT_LABEL } from "../product/fleet.ts";
import { GitHubConnectionError } from "../github/integration.ts";
import type { ByokSetupRecord } from "../runtime/byok.ts";
import { parseUpdateLifecycleRequest, type UpdateLifecycle, type UpdateLifecycleResponse } from "./updateLifecycle.ts";
import {
  productProblem,
  type ProductProblemCode,
} from "./productProblem.ts";
import {
  MOCHI_CONTROL_PROTOCOL_VERSION,
  MAXIMUM_CONTROL_MESSAGE_BYTES,
  isBotScopedCommand,
  parseControlRequest,
  type MochiControlRequest,
  type MochiControlResponse,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export interface ContextOrganizer {
  organizeContext(): Promise<void>;
}

export interface ChatGPTLoginController {
  startChatGPTLogin(): Promise<{ authorizationUrl: string }>;
  cancelChatGPTLogin(): Promise<void>;
  logoutChatGPT(): Promise<void>;
  switchChatGPTAccount(): Promise<{ authorizationUrl: string }>;
}

export interface ByokController {
  configureByok(input: { apiKey: string; baseUrl: string; label: string; model: string; connectionId?: string }): Promise<void>;
  removeByok(connectionId?: string): Promise<void>;
  readByok(): Promise<readonly ByokSetupRecord[]>;
}

export interface ModelPolicyController {
  modelCatalog(): Promise<readonly RuntimeModelOption[]>;
  updateModelPolicy(policy: { model: string; reasoningEffort: string }): Promise<void>;
}

export interface InstructionsController {
  readInstructions(): InstructionDocument;
  saveInstructions(document: InstructionDocument): InstructionDocument;
}
export interface SchedulesController {
  readSchedules(): Promise<readonly ScheduleView[]>;
  setScheduleEnabled(id: string, revision: number, enabled: boolean): void;
  cancelSchedule(id: string, revision: number): void;
}

/** Asks the Bot to recheck its connections now; answered at once, applied in the background. */
export interface ConnectionRecheckController {
  recheckConnections(): void;
}

export interface GroupParticipationController {
  updateGroupParticipation(chatId: string, enabled: boolean): Promise<void>;
}

export interface GitHubConnectionController {
  startGitHubLogin(): Promise<{ authorizationUrl: string }>;
  startGitHubInstallation(): Promise<{ authorizationUrl: string }>;
  cancelGitHubLogin(): Promise<void>;
  disconnectGitHub(): Promise<void>;
}

export interface FeishuConnectionController {
  startFeishuConnection(): Promise<{ authorizationUrl: string }>;
  cancelFeishuConnection(): Promise<void>;
  discardFeishuCandidate(): Promise<void>;
  checkFeishuCandidate(): Promise<void>;
  activateFeishuConnection(): Promise<void>;
  disconnectFeishu(): Promise<void>;
  feishuSettings(): Promise<{ authorizationUrl: string }>;
}

export interface FeishuMailConnectionController {
  startFeishuMailAuthorization(): Promise<{ authorizationUrl: string }>;
  cancelFeishuMailAuthorization(): Promise<void>;
  feishuMailSettings(): Promise<{ authorizationUrl: string }>;
  disconnectFeishuMail(): Promise<void>;
}

export interface ProjectSelectionController {
  selectProjects(repositoryIds: readonly number[]): Promise<void>;
}

export interface ConnectorSelectionController {
  addConnectorResources(connectionId: string, references: readonly string[]): Promise<void>;
  removeConnectorResource(connectionId: string, resourceId: string, selectionId: string): Promise<void>;
}

export interface BotLifecycleController {
  renameBot(label: string): Promise<void>;
  setBotEnabled(enabled: boolean): Promise<void>;
  setBotCharacter(characterId: string): Promise<void>;
  /** Reconnects this one Bot's worker and Feishu events; no other Bot is touched. */
  recoverBot(): Promise<void>;
}

/** Everything one Bot answers for. A Bot can never act for another Bot. */
export type MochiBotActions = ContextOrganizer & ModelPolicyController & InstructionsController & SchedulesController
  & ConnectionRecheckController & GroupParticipationController & FeishuConnectionController & FeishuMailConnectionController
  & ProjectSelectionController & ConnectorSelectionController
  & BotLifecycleController & GitHubConnectionController;

/** Shared ChatGPT login plus explicitly addressed Bot operations. */
export interface MochiControlActions extends ChatGPTLoginController, ByokController {
  createBot(label: string): Promise<{ botId: string }>;
  bot(botId: string): MochiBotActions;
}

export class ControlRejection extends Error {
  readonly problemCode: ProductProblemCode;

  constructor(problemCode: ProductProblemCode) {
    super(problemCode);
    this.name = "ControlRejection";
    this.problemCode = problemCode;
  }
}

export class MochiControlServer {
  readonly #actions: MochiControlActions;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  constructor(actions: MochiControlActions, socketPath: string,
    private readonly update?: { lifecycle: UpdateLifecycle; stop(): Promise<void>; health?(): Promise<{ initialized: boolean; failures: string[] }> }) {
    this.#actions = actions;
    this.#socketPath = socketPath;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const directory = dirname(this.#socketPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    removeStaleSocket(this.#socketPath);

    const server = createServer({ allowHalfOpen: true }, (socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#socketPath);
      });
      chmodSync(this.#socketPath, 0o600);
      log.info("bot.control.ready", { controlSocketPath: this.#socketPath });
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeStaleSocket(this.#socketPath);
  }

  /**
   * Stops serving without touching the socket path, which another Bridge may
   * own by now: closing a listener unlinks its path. The listener is refused
   * and released with the process instead.
   */
  abandon(): void {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    server.on("connection", (socket: Socket) => socket.destroy());
    for (const socket of this.#sockets) socket.destroy();
    server.unref();
  }

  #accept(socket: Socket): void {
    if (!this.#server) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MILLISECONDS, () => socket.destroy());
    let buffer = "";
    let handled = false;

    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_CONTROL_MESSAGE_BYTES) {
        handled = true;
        this.#reply(socket, {
          version: MOCHI_CONTROL_PROTOCOL_VERSION,
          ok: false,
          problem: productProblem("component_contract_mismatch"),
        });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.#handle(socket, buffer.slice(0, newline));
    });
    socket.on("error", (error) => {
      log.warn("bot.control.connection_failed", errorFields(error));
    });
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    socket.setTimeout(0);
    // The first publicly updatable build owns this stable, minimal handshake.
    // Future product-control versions still use the same private socket.
    let value: unknown;
    try { value = JSON.parse(line); } catch { /* ordinary parser owns invalid JSON */ }
    if (value && typeof value === "object" && "lifecycle" in value) {
      let response: UpdateLifecycleResponse;
      try {
        const request = parseUpdateLifecycleRequest(value);
        response = this.update ? this.update.lifecycle.handle(request)
          : { lifecycle: "update", version: 1, ok: false, reason: "unavailable" };
        if (response.ok && request.command === "health" && this.update?.health)
          response = { ...response, ...await this.update.health() };
        socket.end(`${JSON.stringify(response)}\n`, () => {
          if (response.ok && request.command === "stop") {
            void this.update!.stop().catch(() => log.error("update.shutdown_failed", {}));
          }
        });
      } catch { socket.end(`${JSON.stringify({ lifecycle: "update", version: 1, ok: false, reason: "invalid" })}\n`); }
      return;
    }
    let request: MochiControlRequest | undefined;
    let finish: (() => void) | undefined;
    try {
      request = parseControlRequest(line);
      if (this.update) {
        const admitted = this.update.lifecycle.enterOperation();
        if (!admitted) throw new ControlRejection("connection_change_busy");
        finish = admitted;
      }
      const scoped = isBotScopedCommand(request.command) || request.command === "select_projects"
        ? this.#actions.bot((request as { botId: string }).botId)
        : undefined;      switch (request.command) {
        case "read_skills": {
          const skills = readBuiltinSkills();
          log.info("bot.skills.read", { skillCount: skills.length, contentBytes: Buffer.byteLength(JSON.stringify(skills), "utf8") });
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, skills });
          break;
        }
        case "read_schedules":
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, schedules: await scoped!.readSchedules() }); break;
        case "set_schedule_enabled":
          scoped!.setScheduleEnabled(request.scheduleId, request.revision, request.enabled); this.#done(socket); break;
        case "cancel_schedule":
          scoped!.cancelSchedule(request.scheduleId, request.revision); this.#done(socket); break;
        case "read_instructions":
        case "save_instructions": {
          const document = request.command === "save_instructions"
            ? scoped!.saveInstructions(request.document) : scoped!.readInstructions();
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, document });
          break;
        }
        case "start_feishu_connection":
          this.#url(socket, await scoped!.startFeishuConnection()); break;
        case "cancel_feishu_connection":
          await scoped!.cancelFeishuConnection(); this.#done(socket); break;
        case "discard_feishu_candidate":
          await scoped!.discardFeishuCandidate(); this.#done(socket); break;
        case "check_feishu_candidate":
          await scoped!.checkFeishuCandidate(); this.#done(socket); break;
        case "activate_feishu_connection":
          await scoped!.activateFeishuConnection(); this.#done(socket); break;
        case "disconnect_feishu":
          await scoped!.disconnectFeishu(); this.#done(socket); break;
        case "feishu_settings":
          this.#url(socket, await scoped!.feishuSettings()); break;
        case "start_feishu_mail_authorization":
          this.#url(socket, await scoped!.startFeishuMailAuthorization()); break;
        case "cancel_feishu_mail_authorization":
          await scoped!.cancelFeishuMailAuthorization(); this.#done(socket); break;
        case "feishu_mail_settings":
          this.#url(socket, await scoped!.feishuMailSettings()); break;
        case "disconnect_feishu_mail":
          await scoped!.disconnectFeishuMail(); this.#done(socket); break;
        case "start_github_login":
          this.#url(socket, await scoped!.startGitHubLogin()); break;
        case "start_github_installation":
          this.#url(socket, await scoped!.startGitHubInstallation()); break;
        case "cancel_github_login":
          await scoped!.cancelGitHubLogin(); this.#done(socket); break;
        case "disconnect_github":
          await scoped!.disconnectGitHub(); this.#done(socket); break;
        case "select_projects":
          await scoped!.selectProjects(request.repositoryIds); this.#done(socket); break;
        case "remove_connector_resource":
          await scoped!.removeConnectorResource(request.connectionId, request.resourceId, request.selectionId);
          this.#done(socket); break;
        case "add_connector_resources":
          await scoped!.addConnectorResources(request.connectionId, request.references);
          this.#done(socket); break;
        case "organize_context":
          await scoped!.organizeContext(); this.#done(socket); break;
        case "start_chatgpt_login":
          this.#url(socket, await this.#actions.startChatGPTLogin()); break;
        case "cancel_chatgpt_login":
          await this.#actions.cancelChatGPTLogin(); this.#done(socket); break;
        case "logout_chatgpt":
          await this.#actions.logoutChatGPT(); this.#done(socket); break;
        case "switch_chatgpt_account":
          this.#url(socket, await this.#actions.switchChatGPTAccount()); break;
        case "configure_byok":
          await this.#actions.configureByok({ apiKey: request.apiKey, baseUrl: request.baseUrl, label: request.label, model: request.model, ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }) }); this.#done(socket); break;
        case "remove_byok":
          await this.#actions.removeByok(request.connectionId); this.#done(socket); break;
        case "read_byok":
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, connections: await this.#actions.readByok() }); break;
        case "model_catalog": {
          const models = await scoped!.modelCatalog();
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, models });
          break;
        }
        case "recheck_connections":
          scoped!.recheckConnections(); this.#done(socket); break;
        case "update_group_participation":
          await scoped!.updateGroupParticipation(request.chatId, request.enabled); this.#done(socket); break;
        case "update_model_policy":
          await scoped!.updateModelPolicy({ model: request.model, reasoningEffort: request.reasoningEffort });
          this.#done(socket); break;
        case "create_bot": {
          const created = await this.#actions.createBot(request.label ?? DEFAULT_BOT_LABEL);
          this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, botId: created.botId });
          break;
        }
        case "rename_bot":
          await scoped!.renameBot(request.label); this.#done(socket); break;
        case "set_bot_enabled":
          await scoped!.setBotEnabled(request.enabled); this.#done(socket); break;
        case "set_bot_character":
          await scoped!.setBotCharacter(request.characterId); this.#done(socket); break;
        case "recover_bot":
          await scoped!.recoverBot(); this.#done(socket); break;
      }
    } catch (error) {
      const code = error instanceof ScheduleConflictError ? "schedules_conflict"
        : error instanceof ScheduleExpiredError ? "schedule_time_passed"
        : error instanceof InstructionsError ? error.code
        : error instanceof ControlRejection ? error.problemCode
        : error instanceof GitHubConnectionError && error.code === "issuer_not_configured"
        ? "github_issuer_not_configured"
        : error instanceof ConnectorError
        ? connectorProblemCodeFor(error.code, request)
        : problemCodeFor(request?.command);
      // JSON syntax errors can quote the submitted document. Never log request prose.
      log.error("bot.control.action_failed", {
        command: request?.command ?? "invalid",
        problemCode: code,
        ...(request && "botId" in request ? { botId: request.botId } : {}),
      });
      this.#reply(socket, {
        version: MOCHI_CONTROL_PROTOCOL_VERSION,
        ok: false,
        problem: productProblem(code),
      });
    } finally { finish?.(); }
  }

  #done(socket: Socket): void {
    void this.#reply(socket, { version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true });
  }

  #url(socket: Socket, result: { authorizationUrl: string }): void {
    void this.#reply(socket, {
      version: MOCHI_CONTROL_PROTOCOL_VERSION, ok: true, authorizationUrl: result.authorizationUrl,
    });
  }

  #reply(socket: Socket, response: MochiControlResponse): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.once("close", finish);
      socket.end(`${JSON.stringify(response)}\n`, finish);
    });
  }
}

function connectorProblemCodeFor(
  code: ConnectorErrorCode,
  request: MochiControlRequest | undefined,
): ProductProblemCode {
  if (
    (request?.command === "add_connector_resources" || request?.command === "remove_connector_resource") &&
    request.connectionId.startsWith("feishu-mail:")
  ) {
    // Mailbox choices come from the proven shared-mailbox list, so the next
    // step is the same for every failure: refresh that list and choose again.
    return code === "connection_unavailable" ? "feishu_connection_failed" : "feishu_mail_selection_failed";
  }
  if (request?.command !== "add_connector_resources") return problemCodeFor(request?.command);
  switch (code) {
    case "request_invalid":
      return "connector_reference_invalid";
    case "provider_unavailable":
      return "connector_provider_unavailable";
    case "provider_response_invalid":
    case "metadata_incomplete":
      return "connector_provider_response_invalid";
    case "not_readable":
      return "connector_resource_unreadable";
    case "resource_unavailable":
      return "connector_resource_unavailable";
    case "connection_unavailable":
      return "feishu_connection_failed";
    default:
      return "connector_selection_failed";
  }
}

function problemCodeFor(command: MochiControlRequest["command"] | undefined): ProductProblemCode {
  switch (command) {
  case "read_schedules": return "schedules_unavailable";
  case "set_schedule_enabled":
  case "cancel_schedule": return "schedules_update_failed";
  case "read_skills": return "skills_unavailable";
  case "read_instructions":
  case "save_instructions": return "instructions_unavailable";
  case "start_feishu_connection":
  case "cancel_feishu_connection":
  case "discard_feishu_candidate":
  case "check_feishu_candidate":
  case "activate_feishu_connection":
  case "disconnect_feishu":
  case "feishu_settings": return "feishu_connection_failed";
  case "start_feishu_mail_authorization":
  case "cancel_feishu_mail_authorization":
  case "feishu_mail_settings":
  case "disconnect_feishu_mail": return "feishu_mail_unavailable";
  case "start_github_login":
  case "start_github_installation":
  case "cancel_github_login":
  case "disconnect_github": return "github_connection_failed";
  case "select_projects": return "github_selection_failed";
  case "remove_connector_resource":
  case "add_connector_resources": return "connector_selection_failed";
  case "organize_context": return "context_organization_failed";
  case "start_chatgpt_login": return "login_failed";
  case "cancel_chatgpt_login": return "login_cancel_failed";
  case "logout_chatgpt": return "logout_failed";
  case "switch_chatgpt_account": return "account_switch_failed";
  case "configure_byok": return "account_status_unavailable";
  case "read_byok": return "account_status_unavailable";
  case "remove_byok": return "byok_disconnect_failed";
  case "model_catalog": return "model_catalog_unavailable";
  case "update_model_policy": return "model_policy_update_failed";
  case "recheck_connections": return "connector_provider_unavailable";
  case "update_group_participation": return "group_participation_update_failed";
  case "create_bot": return "bot_creation_failed";
  case "set_bot_character": return "bot_character_failed";
  case "rename_bot": return "bot_rename_failed";
  case "set_bot_enabled": return "bot_activation_failed";
  case "recover_bot": return "runtime_session_unavailable";
  case undefined: return "component_contract_mismatch";
  }
}

function removeStaleSocket(path: string): void {
  try {
    const entry = lstatSync(path);
    if (!entry.isSocket()) throw new Error(`Refusing to replace non-socket control path: ${path}`);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
