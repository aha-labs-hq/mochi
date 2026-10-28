import { BotApp } from "./app.ts";
import { ControlRejection, MochiControlServer, type MochiBotActions } from "./control/controlServer.ts";
import { FleetStatusProjection, type BotStatusProjection } from "./control/statusSnapshot.ts";
import { SharedRuntimeAccount } from "./runtime/sharedAccount.ts";
import type { RuntimeAccountClient } from "./runtime/accountClient.ts";
import type { RuntimeAccountObserver } from "./runtime/client.ts";
import { loadBotContext, loadBotContextBeforeSetup } from "./config.ts";
import { createProductGitHubConnection } from "./github/productConnection.ts";
import { Fleet, type BotRecord } from "./product/fleet.ts";
import { provisionBotConfiguration } from "./product/botConfiguration.ts";
import { productLayout, type ProductLayout, type BotLayout } from "./product/layout.ts";
import { errorFields, log } from "./log.ts";
import { ProcessLock } from "./processLock.ts";
import { createBotFeishuConnection } from "./lark/productConnection.ts";
import { resetMaterialWorkspaces } from "./attachments/materialWorkspace.ts";
import { StateStore } from "./state.ts";
import type { ByokSetupRecord } from "./runtime/byok.ts";
import { UpdateLifecycle } from "./control/updateLifecycle.ts";
import { productVersion } from "./product/version.ts";
import { updatePending } from "./product/updateHold.ts";

interface HostedBot { app: BotApp; status: BotStatusProjection }

/** The deployment lock ended while this Bridge was serving. */
export class BridgeLockLostError extends Error {
  constructor() {
    super("The deployment lock was lost while the Bridge was serving");
    this.name = "BridgeLockLostError";
  }
}

/** Owns the shared ChatGPT connection and hosts independently scoped Bots. */
export class Bridge {
  readonly #layout: ProductLayout;
  readonly #fleet: Fleet;
  /** Exists only while this process holds the deployment lock: the lock holder is the one status writer. */
  #status: FleetStatusProjection | undefined;
  readonly #bots = new Map<string, HostedBot>();
  #control: MochiControlServer | undefined;
  #lock: ProcessLock | undefined;
  #startup: Promise<void> | undefined;
  #stopping = false;
  #lockLost = false;
  #stopPromise: Promise<void> | undefined;
  #rosterAdmission: Promise<void> = Promise.resolve();
  #rosterOperations = 0;
  #hostsInitialized = false;
  readonly #hostFailures = new Set<string>();
  readonly #deferredStarts = new Map<string, () => void>();
  #updateReleaseTimer: ReturnType<typeof setInterval> | undefined;
  readonly #update = new UpdateLifecycle(productVersion(), () => {
    const account = this.#account.snapshot();
    return !this.#stopping && this.#rosterOperations === 0 && account.status !== "signingIn"
      && !(account.status === "signedIn" && account.pendingLogin)
      && [...this.#bots.values()].every(({ app }) => app.readyForUpdate());
  }, Date.now, () => this.#layout.mode === "installed" && updatePending());
  readonly #lifecycle = Promise.withResolvers<void>();
  readonly #account: SharedRuntimeAccount;

  constructor(layout = productLayout(), private readonly resetMaterials = resetMaterialWorkspaces,
    createAccountClient?: (observer: RuntimeAccountObserver) => RuntimeAccountClient) {
    this.#layout = layout;
    this.#fleet = new Fleet(layout.fleetRecordPath);
    this.#account = new SharedRuntimeAccount({
      serialize: (operation) => this.#serializeRoster(operation),
      participants: () => [...this.#bots.values()].map(({ app }) => app),
      publish: (snapshot) => this.#statusProjection().accountChanged(snapshot),
      acceptingChanges: () => this.#update.acceptingWork,
    }, createAccountClient);
  }

  async start(): Promise<void> {
    if (this.#startup) throw new Error("Bridge has already started");
    this.#startup = this.#startHosts();
    await this.#startup;
    await this.#lifecycle.promise;
    if (this.#lockLost) throw new BridgeLockLostError();
  }

  async #startHosts(): Promise<void> {
    const lock = await ProcessLock.acquire(this.#layout.deploymentLockPath);
    this.#lock = lock;
    this.#status = new FleetStatusProjection(this.#layout.statusSnapshotPath);
    void lock.lost.then(() => this.#failClosed());
    if (this.#stopping) return;
    // Only the host can clean abandoned turn workspaces, before any Bot starts.
    this.resetMaterials();
    this.#publishRoster();
    await this.#account.start();
    this.#control = new MochiControlServer(this, this.#layout.controlSocketPath,
      { lifecycle: this.#update, stop: () => this.stop(), health: () => this.#updateHealth() });
    await this.#control.start();
    this.#statusProjection().controlReady();
    for (const record of this.#fleet.bots()) {
      await this.#serializeRoster(() => this.#host(record));
    }
    this.#hostsInitialized = true;
    if (this.#deferredStarts.size) this.#updateReleaseTimer = setInterval(() => {
      if (this.#stopping || !this.#update.acceptingWork) return;
      clearInterval(this.#updateReleaseTimer);
      for (const start of this.#deferredStarts.values()) start();
      this.#deferredStarts.clear();
    }, 250);
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    clearInterval(this.#updateReleaseTimer);
    this.#stopPromise = (async () => {
      await this.#startup?.catch(() => undefined);
      // Without the lock, the socket path may already belong to another Bridge.
      if (this.#lockLost) this.#control?.abandon();
      else await this.#control?.stop();
      await this.#rosterAdmission;
      await Promise.allSettled([...this.#bots.values()].map(({ app }) => app.stop()));
      this.#bots.clear();
      await this.#account.close();
      this.#status?.stopping();
      await this.#lock?.release();
      this.#lifecycle.resolve();
    })();
    return this.#stopPromise;
  }

  /** Only the lock holder publishes a deployment failure; a refused second Bridge writes nothing. */
  fail(code: "bridge_startup_failed" | "fleet_storage_unavailable"): void { this.#status?.failed(code); }

  /**
   * The kernel released the deployment lock while this Bridge still served, so
   * another Bridge may already own the status file and control socket. Stop
   * writing either at once, then shut every Bot down.
   */
  #failClosed(): void {
    if (this.#lockLost) return;
    this.#lockLost = true;
    this.#status?.close();
    this.#control?.abandon();
    log.error("bridge.lock_lost", { deploymentLockPath: this.#layout.deploymentLockPath });
    void this.stop().catch((error) => log.error("bridge.shutdown_failed", errorFields(error)));
  }

  #statusProjection(): FleetStatusProjection {
    if (!this.#status) throw new Error("Bridge status is published only by the deployment lock holder");
    return this.#status;
  }

  createBot(label: string): Promise<{ botId: string }> {
    return this.#serializeRoster(async () => {
      const record = this.#fleet.create(label, provisionBotConfiguration);
      this.#publishRoster();
      await this.#host(record);
      return { botId: record.id };
    });
  }

  bot(botId: string): MochiBotActions {
    const record = this.#fleet.bots().find((bot) => bot.id === botId);
    if (!record) throw new ControlRejection("bot_unknown");
    const app = () => {
      const hosted = this.#bots.get(botId);
      if (!hosted) throw new ControlRejection("bot_not_running");
      return hosted.app;
    };
    return {
      startGitHubLogin: () => app().startGitHubLogin(),
      startGitHubInstallation: () => app().startGitHubInstallation(),
      cancelGitHubLogin: () => app().cancelGitHubLogin(),
      disconnectGitHub: () => app().disconnectGitHub(),
      setBotCharacter: (characterId) => this.#setCharacter(botId, characterId),
      organizeContext: () => app().organizeContext(),
      modelCatalog: () => app().modelCatalog(),
      updateModelPolicy: (policy) => app().updateModelPolicy(policy),
      readInstructions: () => app().readInstructions(),
      readSchedules: () => app().readSchedules(),
      setScheduleEnabled: (id, revision, enabled) => app().setScheduleEnabled(id, revision, enabled),
      cancelSchedule: (id, revision) => app().cancelSchedule(id, revision),
      saveInstructions: (document) => app().saveInstructions(document),
      recheckConnections: () => app().recheckConnections(),
      updateGroupParticipation: (chatId, enabled) => app().updateGroupParticipation(chatId, enabled),
      startFeishuConnection: () => app().startFeishuConnection(),
      cancelFeishuConnection: () => app().cancelFeishuConnection(),
      discardFeishuCandidate: () => app().discardFeishuCandidate(),
      checkFeishuCandidate: () => app().checkFeishuCandidate(),
      activateFeishuConnection: () => app().activateFeishuConnection(),
      disconnectFeishu: () => app().disconnectFeishu(),
      feishuSettings: () => app().feishuSettings(),
      startFeishuMailAuthorization: () => app().startFeishuMailAuthorization(),
      cancelFeishuMailAuthorization: () => app().cancelFeishuMailAuthorization(),
      feishuMailSettings: () => app().feishuMailSettings(),
      disconnectFeishuMail: () => app().disconnectFeishuMail(),
      selectProjects: (repositoryIds) => app().selectProjects(repositoryIds),
      addConnectorResources: (connectionId, references) =>
        app().addConnectorResources(connectionId, references),
      removeConnectorResource: (connectionId, resourceId, selectionId) =>
        app().removeConnectorResource(connectionId, resourceId, selectionId),
      renameBot: (label) => this.#rename(botId, label),
      setBotEnabled: (enabled) => this.#serializeRoster(() => this.#setEnabled(botId, enabled)),
      recoverBot: () => this.#recover(botId),
    };
  }

  /**
   * One Bot's own recovery. A hosted Bot reconnects its worker and events; a Bot
   * whose start failed is hosted again. No other Bot or the shared account moves.
   */
  async #recover(botId: string): Promise<void> {
    const hosted = this.#bots.get(botId);
    if (hosted) return hosted.app.recover();
    await this.#serializeRoster(() => this.#host(this.#fleet.bots().find((bot) => bot.id === botId)!));
    if (!this.#bots.has(botId)) throw new ControlRejection("bot_not_running");
  }

  async #host(record: BotRecord): Promise<void> {
    if (this.#stopping || this.#bots.has(record.id)) return;
    record = this.#fleet.bots().find(bot => bot.id === record.id)!;
    const layout = this.#layout.bot(record.id);
    const status = this.#statusProjection().bot(record.id);
    let lock: ProcessLock | undefined;
    try {
      // Acquire before opening SQLite, preparing a candidate or clearing staging.
      lock = await ProcessLock.acquire(layout.stateLockPath);
      const sessionId = currentSessionId(layout.stateDatabasePath);
      const bot = sessionId ? loadBotContext(layout, sessionId)
        : loadBotContextBeforeSetup(layout, prepareSetupCandidate(layout));
      const app = new BotApp({ bot, status, lock, enabled: record.enabled,
        acceptingWork: () => this.#update.acceptingWork,
        account: this.#account,
        github: createProductGitHubConnection(layout), feishu: createBotFeishuConnection(layout) });
      this.#bots.set(record.id, { app, status });
      this.#hostFailures.delete(record.id);
      lock = undefined;
      const start = () => { void app.start().catch(async (error) => {
        if (this.#stopping) return;
        log.error("bot.start_failed", { botId: record.id, ...errorFields(error) });
        await this.#serializeRoster(async () => {
          try { await app.stop(); }
          finally {
            if (this.#bots.get(record.id)?.app === app) this.#bots.delete(record.id);
            this.#hostFailures.add(record.id);
            status.failed();
          }
        }).catch((stopError) => {
          if (!this.#stopping) log.error("bot.cleanup_failed", { botId: record.id, ...errorFields(stopError) });
        });
      }); };
      if (this.#layout.mode === "installed" && updatePending()) {
        // Verify local history before opening any external intake. The account
        // worker and this check never need a remote model/Feishu/GitHub request.
        try { await app.verifyForUpdate(); } catch { this.#hostFailures.add(record.id); }
        this.#deferredStarts.set(record.id, start);
      } else start();
    } catch (error) {
      this.#hostFailures.add(record.id);
      await lock?.release();
      status.failed();
      log.error("bot.load_failed", { botId: record.id, ...errorFields(error) });
    }
  }

  async #updateHealth(): Promise<{ initialized: boolean; failures: string[] }> {
    if (!this.#hostsInitialized || this.#update.acceptingWork) return { initialized: false, failures: [] };
    const failures = new Set(this.#hostFailures);
    if (this.#account.snapshot().status === "unknown") failures.add("shared-account");
    for (const [id, { app }] of this.#bots) {
      try { await app.verifyForUpdate(); } catch { failures.add(id); }
    }
    return { initialized: true, failures: [...failures].sort() };
  }

  async #rename(botId: string, label: string): Promise<void> {
    this.#fleet.rename(botId, label);
    this.#publishRoster();
  }

  async #setCharacter(botId: string, characterId: string): Promise<void> {
    this.#fleet.setCharacter(botId, characterId);
    this.#publishRoster();
  }

  async #setEnabled(botId: string, enabled: boolean): Promise<void> {
    let hosted = this.#bots.get(botId);
    if (!hosted) {
      if (!enabled) {
        this.#fleet.setEnabled(botId, false);
        this.#publishRoster();
        this.#statusProjection().bot(botId).paused();
        return;
      }
      await this.#host(this.#fleet.bots().find((bot) => bot.id === botId)!);
      hosted = this.#bots.get(botId);
      if (!hosted) throw new ControlRejection("bot_not_running");
    }
    await hosted.app.setEnabled(enabled, () => {
      this.#fleet.setEnabled(botId, enabled);
      this.#publishRoster();
    });
  }

  #publishRoster(): void {
    this.#statusProjection().roster(this.#fleet.bots());
  }

  startChatGPTLogin(): Promise<{ authorizationUrl: string }> {
    return this.#account.startChatGPTLogin();
  }

  cancelChatGPTLogin(): Promise<void> {
    return this.#account.cancelChatGPTLogin();
  }

  logoutChatGPT(): Promise<void> {
    return this.#account.logoutChatGPT();
  }

  switchChatGPTAccount(): Promise<{ authorizationUrl: string }> {
    return this.#account.switchChatGPTAccount();
  }

  configureByok(input: { apiKey: string; baseUrl: string; label: string; model: string; connectionId?: string }): Promise<void> {
    return this.#account.configureByok(input);
  }

  removeByok(connectionId?: string): Promise<void> { return this.#account.removeByok(connectionId); }

  readByok(): Promise<readonly ByokSetupRecord[]> { return this.#account.readByok(); }

  #serializeRoster<T>(operation: () => Promise<T>): Promise<T> {
    this.#rosterOperations++;
    const result = this.#rosterAdmission.then(() => {
      if (this.#stopping) throw new ControlRejection("bot_not_running");
      return operation();
    });
    this.#rosterAdmission = result.then(() => undefined, () => undefined);
    return result.finally(() => { this.#rosterOperations--; });
  }
}

function prepareSetupCandidate(layout: BotLayout): string {
  const state = new StateStore(layout.stateDatabasePath);
  try {
    const prepared = state.runtimeSetupSessionId();
    if (prepared) return prepared;
    return state.prepareRuntimeSetupSession(crypto.randomUUID());
  } finally {
    state.close();
  }
}

/** The Session a Bot already activated, if its setup has completed. */
function currentSessionId(stateDatabasePath: string): string | undefined {
  const state = new StateStore(stateDatabasePath);
  try {
    return state.runtimeSession()?.sessionId;
  } finally {
    state.close();
  }
}
