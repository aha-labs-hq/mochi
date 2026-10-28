import { canonicalJson } from "../canonical.ts";
import { ConnectorError } from "../errors.ts";
import type {
  ConnectorAdapter,
  ConnectorCapabilityManifest,
  ConnectorConnectionSnapshot,
  ConnectorRequestContext,
  ConnectorResourceSnapshot,
  ConnectorTaskGrant,
  ConnectorWriteResult,
  JsonValue,
} from "../protocol.ts";
import type {
  ConnectorResourceSelection,
  ConnectorSelectionStore,
} from "../selectionStore.ts";
import {
  type FeishuMailAuthorization,
  FeishuMailAuthorizationError,
  type FeishuMailAuthorizationOutcome,
} from "./authorization.ts";
import {
  FEISHU_MAIL_MANIFEST,
  FEISHU_MAIL_PROVIDER_ID,
  FEISHU_MAIL_RESOURCE_TYPE,
} from "./manifest.ts";
import {
  type FeishuAccessibleMailbox,
  type FeishuMailIdentity,
  type FeishuMailReader,
  FeishuMailReaderError,
  mailboxResourceId,
  normalizeMailboxAddress,
  parseMailboxResourceId,
} from "./reader.ts";

export interface FeishuMailBinding {
  readonly brand: import("../../lark/platform.ts").LarkBrand;
  readonly cliPath: string;
  readonly profile: string;
  readonly configDirectory: string;
  /** The Feishu app transport is not the mailbox identity. */
  readonly targetAppId: string;
  readonly status: "ready" | "unavailable";
  readonly problem: string | null;
}

export type FeishuMailReaderFactory = (
  binding: FeishuMailBinding,
) => FeishuMailReader;

/**
 * Only a team mailbox is a choice. The user's own primary or alias address,
 * and a mail group that has no mailbox of its own, never become options, so
 * the user's personal address is never published as a Bot fact.
 */
const SHARED_MAILBOX_TYPE = "PUBLIC_MAILBOX";

type ProofState =
  | { kind: "unknown" }
  | { kind: "ready"; identity: FeishuMailIdentity }
  | { kind: "unavailable"; problem: FeishuMailReaderError["code"] };

/**
 * A separate connector for Feishu Mail. It owns its user grant, mailbox range
 * and user proof, and deliberately exposes no write method in its manifest.
 */
export class FeishuMailConnector implements ConnectorAdapter {
  readonly manifest = FEISHU_MAIL_MANIFEST;
  readonly #binding: () => FeishuMailBinding | undefined;
  readonly #selections: ConnectorSelectionStore;
  readonly #reader: FeishuMailReaderFactory;
  readonly #authorization: FeishuMailAuthorization;
  readonly #authorizationSettled: (
    outcome: FeishuMailAuthorizationOutcome,
    proved: boolean,
  ) => void;
  #proof: ProofState = { kind: "unknown" };
  /** Display-only continuity; it never authorizes a call while #proof is not ready. */
  #lastIdentity: FeishuMailIdentity | undefined;
  /** Shared mailboxes from the last directory read; options to choose, never authority. */
  #sharedMailboxes: readonly FeishuAccessibleMailbox[] = [];
  /** Whether the last directory read for the proven identity succeeded. */
  #directoryAvailable = false;
  /** An attempt ended and is being re-proved; it still reads as authorizing. */
  #settling = false;
  /** The last attempt ended without a usable identity; cleared by a new attempt or proof. */
  #authorizationIncomplete = false;
  #resourceProofConnectionId: string | undefined;
  #resourceProofFingerprint: string | undefined;
  #resourceProofState: "unknown" | "ready" | "unavailable" = "unknown";
  #resourceProofProblem: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    binding: () => FeishuMailBinding | undefined,
    selections: ConnectorSelectionStore,
    reader: FeishuMailReaderFactory,
    authorization: {
      readonly flow: FeishuMailAuthorization;
      /**
       * Called after a settled attempt has been re-proved, so the catalog can
       * be republished. `proved` says whether a usable user identity followed.
       */
      readonly settled: (
        outcome: FeishuMailAuthorizationOutcome,
        proved: boolean,
      ) => void;
    },
  ) {
    this.#binding = binding;
    this.#selections = selections;
    this.#reader = reader;
    this.#authorization = authorization.flow;
    this.#authorizationSettled = authorization.settled;
  }

  invalidateProof(): void {
    this.#proof = { kind: "unknown" };
    this.#sharedMailboxes = [];
    this.#directoryAvailable = false;
    this.#resourceProofConnectionId = undefined;
    this.#resourceProofFingerprint = undefined;
    this.#resourceProofState = "unknown";
    this.#resourceProofProblem = undefined;
    // A replaced or lost Feishu App cannot finish a grant started on the old one.
    const binding = this.#binding();
    if (binding?.status !== "ready" || !this.#authorization.pending(binding)) {
      void this.#authorization.cancel();
    }
  }

  authorizing(): boolean {
    const binding = this.#binding();
    return binding !== undefined && this.#authorization.pending(binding);
  }

  /**
   * Whether there is a grant or a saved range worth rechecking. A Bot that never
   * authorized mail has nothing to keep current until the user starts a grant.
   */
  hasGrantToKeepFresh(): boolean {
    const binding = this.#binding();
    return (
      this.#proof.kind === "ready" ||
      this.#lastIdentity !== undefined ||
      (binding !== undefined &&
        this.#selections.connectorSelections(this.#connectionId(binding))
          .length > 0)
    );
  }

  /** Whether a usable user grant is proved now; replacing it pauses mailbox reads. */
  hasProvenGrant(): boolean {
    return this.#proof.kind === "ready";
  }

  /** The catalog identity the current binding can answer for, if any. */
  connectionId(): string | undefined {
    const binding = this.#binding();
    return binding ? this.#connectionId(binding) : undefined;
  }

  /**
   * Starts (or hands back) the user's read-only grant. Completion needs no
   * report from the user: the attempt polls, then the identity and directory
   * are re-proved and the settled callback republishes the catalog.
   */
  async startAuthorization(): Promise<{ authorizationUrl: string }> {
    const binding = this.#requireReadyBinding();
    const attempt = await this.#authorization.start(binding);
    if (!attempt.resumed) {
      this.#authorizationIncomplete = false;
      void attempt.settled.then((outcome) => this.#settle(outcome));
    }
    return { authorizationUrl: attempt.authorizationUrl };
  }

  /** Stops waiting for the user; an existing grant and mailbox range are unchanged. */
  cancelAuthorization(): Promise<void> {
    return this.#authorization.cancel();
  }

  /** The Feishu consent page for the mail scopes the app has not enabled yet. */
  scopeApplyUrl(): Promise<string> {
    const binding = this.#requireReadyBinding();
    return this.#authorization.scopeApplyUrl(binding, binding.targetAppId);
  }

  /**
   * Ends the user grant on this Bot: Feishu is asked to revoke it, the CLI
   * profile forgets the user token (the App and Bot credentials stay), and every
   * saved mailbox is dropped. The result is re-proved, not assumed.
   */
  disconnect(): Promise<void> {
    return this.#serialize(async () => {
      const binding = this.#requireReadyBinding();
      await this.#authorization.logout(binding);
      this.#retireOtherAccounts(undefined);
      this.#lastIdentity = undefined;
      this.#authorizationIncomplete = false;
      await this.#reconcile();
      if (this.#proof.kind === "ready") {
        throw new FeishuMailAuthorizationError("authorization_unavailable");
      }
    });
  }

  /** Ends any attempt still polling; used when the Bot stops. */
  close(): Promise<void> {
    return this.#authorization.cancel();
  }

  async snapshot(
    botId: string,
  ): Promise<readonly ConnectorConnectionSnapshot[]> {
    const binding = this.#binding();
    if (!binding) return [];
    const connectionId = this.#connectionId(binding);
    const selections = this.#selections.connectorSelections(connectionId);
    const proof = this.#proof;
    const identity =
      proof.kind === "ready" ? proof.identity : this.#lastIdentity;
    const authorizing =
      binding.status === "ready" &&
      (this.#settling || this.#authorization.pending(binding));
    // Feishu says there is no user grant, nothing is saved and no attempt is
    // waiting: "not connected", not a broken connection. Before the first check
    // the answer is unknown, which is published as checking below instead.
    if (
      !authorizing &&
      !identity &&
      selections.length === 0 &&
      !this.#authorizationIncomplete &&
      proof.kind === "unavailable" &&
      proof.problem === "authorization_required"
    ) {
      return [];
    }
    const { status, problem } = authorizing
      ? { status: "authorizing" as const, problem: null }
      : binding.status !== "ready"
        ? {
            status: "unavailable" as const,
            problem: binding.problem ?? "provider_unavailable",
          }
        : proof.kind === "ready" &&
            !this.#directoryAvailable &&
            selections.length === 0
          ? // The grant is proved but there is nothing to choose from or keep.
            { status: "unavailable" as const, problem: "provider_unavailable" }
          : proof.kind === "ready"
            ? { status: "ready" as const, problem: null }
            : this.#authorizationIncomplete
              ? {
                  status: "reauthorization_required" as const,
                  problem: "mail_authorization_incomplete",
                }
              : proof.kind === "unavailable" &&
                  proof.problem === "authorization_required"
                ? {
                    status: "reauthorization_required" as const,
                    problem: "authorization_required",
                  }
                : proof.kind === "unavailable"
                  ? { status: "unavailable" as const, problem: proof.problem }
                  : {
                      status: "unavailable" as const,
                      problem: "resource_reconciliation_required",
                    };
    const proofState = this.#resourceProofStateFor(connectionId, selections);
    const selectedIds = new Set(
      selections.map((selection) => selection.resourceId),
    );
    // Saved choices first keep their identity; proven shared mailboxes follow
    // as options only while the connection itself is ready.
    const options =
      status === "ready"
        ? this.#sharedMailboxes.filter(
            (mailbox) => !selectedIds.has(mailboxResourceId(mailbox.address)),
          )
        : [];
    return [
      {
        botId,
        connectionId,
        providerId: FEISHU_MAIL_PROVIDER_ID,
        status,
        ...(problem === null ? {} : { problem }),
        account: identity ? { displayName: identity.displayName } : null,
        grantedScopes: identity?.grantedScopes ?? [],
        resourceScope:
          selections.length === 0
            ? { status: "ready" as const, selectedCount: 0 }
            : {
                status:
                  status !== "ready"
                    ? ("unavailable" as const)
                    : proofState === "unknown"
                      ? ("checking" as const)
                      : proofState,
                selectedCount: selections.length,
                ...(status !== "ready"
                  ? { problem: problem ?? "provider_unavailable" }
                  : proofState === "unknown"
                    ? { problem: "resource_reconciliation_required" }
                    : proofState === "unavailable"
                      ? {
                          problem:
                            this.#resourceProofProblem ??
                            "provider_unavailable",
                        }
                      : {}),
              },
        resources: [
          ...selections.map(
            (selection): ConnectorResourceSnapshot => ({
              id: selection.resourceId,
              type: selection.resourceType,
              displayName: selection.displayName,
              selected: true,
            }),
          ),
          ...options.map(
            (mailbox): ConnectorResourceSnapshot => ({
              id: mailboxResourceId(mailbox.address),
              type: FEISHU_MAIL_RESOURCE_TYPE,
              displayName: mailbox.address,
              selected: false,
            }),
          ),
        ],
      },
    ];
  }

  async read(input: {
    context: ConnectorRequestContext;
    grant: ConnectorTaskGrant;
    connection: ConnectorConnectionSnapshot;
    resource: ConnectorResourceSnapshot;
    capability: ConnectorCapabilityManifest;
    input: JsonValue;
    signal?: AbortSignal;
  }): Promise<JsonValue> {
    const binding = this.#binding();
    if (binding?.status !== "ready") {
      throw new ConnectorError("connection_unavailable", "飞书邮箱连接不可用");
    }
    const connectionId = this.#connectionId(binding);
    if (input.connection.connectionId !== connectionId) {
      throw new ConnectorError(
        "connection_unavailable",
        "飞书邮箱连接与请求不一致",
      );
    }
    if (this.#proof.kind !== "ready") {
      throw new ConnectorError(
        "authorization_missing",
        "飞书邮箱尚未完成用户授权",
      );
    }
    if (
      this.#resourceProofStateFor(
        connectionId,
        this.#selections.connectorSelections(connectionId),
      ) !== "ready"
    ) {
      throw new ConnectorError(
        "resource_unavailable",
        "飞书邮箱范围尚未完成复核",
      );
    }
    const selection = this.#selections
      .connectorSelections(connectionId)
      .find((candidate) => candidate.resourceId === input.resource.id);
    if (!selection || selection.resourceType !== FEISHU_MAIL_RESOURCE_TYPE) {
      throw new ConnectorError("resource_not_selected", "飞书邮箱未选择该邮箱");
    }
    const addressToken = parseMailboxResourceId(selection.resourceId);
    if (
      !addressToken ||
      mailboxResourceId(selection.address) !== selection.resourceId
    ) {
      throw new ConnectorError("resource_not_selected", "飞书邮箱资源标识无效");
    }
    const reader = this.#reader(binding);
    try {
      if (input.capability.id === "thread.list") {
        const body = objectInput(input.input);
        const listInput: {
          mailbox: string;
          folder?: string;
          onlyUnread?: boolean;
          limit: number;
        } = {
          mailbox: selection.address,
          limit: integerInput(body.limit, 20, 1, 20),
        };
        const folder = enumString(body.folder, [
          "INBOX",
          "SENT",
          "ARCHIVED",
          "SPAM",
          "TRASH",
          "DRAFT",
          "SCHEDULED",
        ]);
        if (folder !== undefined) listInput.folder = folder;
        if (body.only_unread === true) listInput.onlyUnread = true;
        const rows = await reader.listThreads(listInput);
        return {
          mailbox: selection.displayName,
          contentTrust: "external",
          threads: rows.map((row) => ({
            threadId: row.threadId,
            ...(row.preview ? { preview: row.preview } : {}),
          })),
        };
      }
      if (input.capability.id === "thread.read") {
        const body = objectInput(input.input);
        const threadId =
          typeof body.thread_id === "string" ? body.thread_id : "";
        if (!/^[A-Za-z0-9+/=_-]{1,256}$/.test(threadId)) {
          throw new ConnectorError("input_invalid", "邮件会话标识无效");
        }
        const thread = await reader.readThread({
          mailbox: selection.address,
          threadId,
          includeSpamTrash: body.include_spam_trash === true,
        });
        return {
          mailbox: selection.displayName,
          contentTrust: "external",
          threadId: thread.threadId,
          messages: thread.messages.map(mailMessageJson),
        };
      }
      throw new ConnectorError(
        "capability_unavailable",
        `飞书邮箱能力未实现：${input.capability.id}`,
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error instanceof FeishuMailReaderError) {
        throw new ConnectorError(
          error.code === "authorization_required"
            ? "authorization_missing"
            : "provider_unavailable",
          `飞书邮箱读取失败：${error.code}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async write(): Promise<ConnectorWriteResult> {
    throw new ConnectorError(
      "capability_unavailable",
      "飞书邮箱连接器只提供读取能力",
    );
  }

  /** Adds only shared mailboxes proved by the official accessible-mailboxes endpoint. */
  addMailboxes(addresses: readonly string[]): Promise<void> {
    return this.#serialize(async () => {
      const binding = this.#requireReadyBinding();
      const identity = await this.#ensureProof(binding);
      // The options on screen came from the latest directory proof, which the
      // Bot rechecks every minute; choosing one needs no second network read.
      // Feishu still enforces the user's access on every mailbox read.
      if (!this.#directoryAvailable) {
        this.#sharedMailboxes = sharedMailboxes(
          await this.#available(this.#reader(binding)),
        );
        this.#directoryAvailable = true;
      }
      const shared = this.#sharedMailboxes;
      const byAddress = new Map(
        shared.map((mailbox) => [mailbox.address, mailbox]),
      );
      const connectionId = this.#connectionId(binding);
      const existing = this.#selections.connectorSelections(connectionId);
      if (
        existing.length > 0 &&
        this.#resourceProofStateFor(connectionId, existing) !== "ready"
      ) {
        throw new ConnectorError(
          "resource_unavailable",
          "飞书邮箱范围尚未完成复核",
        );
      }
      const byId = new Map(existing.map((row) => [row.resourceId, row]));
      const additions: ConnectorResourceSelection[] = [];
      for (const raw of addresses) {
        const address = normalizeMailboxAddress(raw);
        const mailbox = address ? byAddress.get(address) : undefined;
        if (!mailbox) {
          throw new ConnectorError(
            "resource_not_selected",
            "该邮箱不是当前用户可访问的共享邮箱",
          );
        }
        const resourceId = mailboxResourceId(mailbox.address);
        if (byId.has(resourceId)) continue;
        const selection: ConnectorResourceSelection = {
          connectionId,
          resourceId,
          resourceType: FEISHU_MAIL_RESOURCE_TYPE,
          displayName: mailbox.address,
          address: mailbox.address,
          selectionId: crypto.randomUUID().replaceAll("-", ""),
        };
        byId.set(resourceId, selection);
        additions.push(selection);
      }
      this.#selections.replaceConnectorSelections(connectionId, [
        ...existing,
        ...additions,
      ]);
      this.#setResourceProofState(
        connectionId,
        "ready",
        this.#selections.connectorSelections(connectionId),
      );
      // Keep the identity in memory even if the provider returned no mailbox rows.
      this.#proof = { kind: "ready", identity };
    });
  }

  remove(resourceId: string, selectionId: string): Promise<void> {
    return this.#serialize(async () => {
      const binding = this.#requireReadyBinding();
      const connectionId = this.#connectionId(binding);
      const existing = this.#selections.connectorSelections(connectionId);
      const row = existing.find(
        (selection) => selection.resourceId === resourceId,
      );
      if (!row || row.selectionId !== selectionId) {
        throw new ConnectorError(
          "resource_not_selected",
          "连接器资源选择已变化",
        );
      }
      this.#selections.replaceConnectorSelections(
        connectionId,
        existing.filter((selection) => selection.resourceId !== resourceId),
      );
      this.#setResourceProofState(
        connectionId,
        "ready",
        this.#selections.connectorSelections(connectionId),
      );
    });
  }

  /**
   * Re-proves the user grant, refreshes the shared mailboxes offered for
   * selection, and removes saved mailboxes that are no longer accessible.
   */
  reconcile(): Promise<boolean> {
    return this.#serialize(() => this.#reconcile());
  }

  async #reconcile(): Promise<boolean> {
    const binding = this.#binding();
    if (!binding) return false;
    // The previous answer stays published until this one is known, so a recheck
    // never flashes a connected page as disconnected or vice versa.
    const reader = this.#reader(binding);
    let identity: FeishuMailIdentity;
    try {
      identity = await reader.probe();
    } catch (error) {
      const problem =
        error instanceof FeishuMailReaderError
          ? error.code
          : "provider_unavailable";
      this.#proof = { kind: "unavailable", problem };
      this.#sharedMailboxes = [];
      this.#directoryAvailable = false;
      this.#resourceProofState = "unavailable";
      this.#resourceProofProblem = problem;
      return false;
    }
    // The proof is published together with the directory below, so a reader
    // never sees a proven identity whose mailbox options are still missing.
    const connectionId = `feishu-mail:${identity.accountId}`;
    const stored = this.#selections.connectorSelections(connectionId);
    const prove = () => {
      this.#proof = { kind: "ready", identity };
      this.#lastIdentity = identity;
      this.#authorizationIncomplete = false;
      this.#retireOtherAccounts(connectionId);
    };
    if (binding.status !== "ready") {
      prove();
      this.#sharedMailboxes = [];
      this.#directoryAvailable = false;
      this.#setResourceProofState(connectionId, "unavailable", stored);
      return false;
    }
    let shared: readonly FeishuAccessibleMailbox[];
    try {
      shared = sharedMailboxes(await this.#available(reader));
    } catch (error) {
      prove();
      this.#sharedMailboxes = [];
      this.#directoryAvailable = false;
      this.#setResourceProofState(connectionId, "unavailable", stored);
      throw error;
    }
    const allowed = new Set(
      shared.map((mailbox) => mailboxResourceId(mailbox.address)),
    );
    const remaining = stored.filter((selection) =>
      allowed.has(selection.resourceId),
    );
    const changed = remaining.length !== stored.length;
    if (changed)
      this.#selections.replaceConnectorSelections(connectionId, remaining);
    prove();
    this.#sharedMailboxes = shared;
    this.#directoryAvailable = true;
    this.#setResourceProofState(connectionId, "ready", remaining);
    return changed;
  }

  /** Re-proves after any attempt: the CLI's exit status is not the grant. */
  async #settle(outcome: FeishuMailAuthorizationOutcome): Promise<void> {
    if (outcome !== "cancelled") {
      this.#settling = true;
      try {
        await this.reconcile();
      } catch {
        // The identity proof is already recorded; a directory failure is
        // published by the snapshot that the settled callback republishes.
      } finally {
        this.#settling = false;
      }
      if (outcome === "incomplete" && this.#proof.kind !== "ready") {
        this.#authorizationIncomplete = true;
      }
    }
    this.#authorizationSettled(outcome, this.#proof.kind === "ready");
  }

  /**
   * The mailbox range belongs to the account proved now. A previous account's
   * rows (another user, or the same person under a replaced App) no longer apply
   * and are dropped rather than kept for an account that may never return.
   */
  #retireOtherAccounts(current: string | undefined): void {
    for (const connectionId of this.#selections.connectorSelectionConnectionIds()) {
      if (
        connectionId.startsWith(`${FEISHU_MAIL_PROVIDER_ID}:`) &&
        connectionId !== current
      ) {
        this.#selections.replaceConnectorSelections(connectionId, []);
      }
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireReadyBinding(): FeishuMailBinding {
    const binding = this.#binding();
    if (binding?.status !== "ready") {
      throw new ConnectorError("connection_unavailable", "飞书邮箱连接不可用");
    }
    return binding;
  }

  async #ensureProof(binding: FeishuMailBinding): Promise<FeishuMailIdentity> {
    if (this.#proof.kind === "ready") return this.#proof.identity;
    try {
      const identity = await this.#reader(binding).probe();
      this.#proof = { kind: "ready", identity };
      this.#lastIdentity = identity;
      return identity;
    } catch (error) {
      const code =
        error instanceof FeishuMailReaderError
          ? error.code
          : "provider_unavailable";
      this.#proof = { kind: "unavailable", problem: code };
      throw new ConnectorError(
        code === "authorization_required"
          ? "authorization_missing"
          : "connection_unavailable",
        `飞书邮箱授权不可用：${code}`,
        { cause: error },
      );
    }
  }

  async #available(
    reader: FeishuMailReader,
  ): Promise<readonly FeishuAccessibleMailbox[]> {
    try {
      return await reader.accessibleMailboxes();
    } catch (error) {
      if (error instanceof FeishuMailReaderError) {
        throw new ConnectorError(
          error.code === "authorization_required"
            ? "authorization_missing"
            : "provider_unavailable",
          `飞书邮箱目录读取失败：${error.code}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  #connectionId(binding: FeishuMailBinding): string {
    return this.#proof.kind === "ready"
      ? `feishu-mail:${this.#proof.identity.accountId}`
      : this.#lastIdentity
        ? `feishu-mail:${this.#lastIdentity.accountId}`
        : `feishu-mail:unverified:${binding.targetAppId}`;
  }

  #resourceProofStateFor(
    connectionId: string,
    selections: readonly ConnectorResourceSelection[],
  ): "unknown" | "ready" | "unavailable" {
    if (selections.length === 0) return "ready";
    return this.#resourceProofConnectionId === connectionId &&
      this.#resourceProofFingerprint === resourceProofFingerprint(selections)
      ? this.#resourceProofState
      : "unknown";
  }

  #setResourceProofState(
    connectionId: string,
    state: "unknown" | "ready" | "unavailable",
    selections: readonly ConnectorResourceSelection[],
    problem?: string,
  ): void {
    this.#resourceProofConnectionId = connectionId;
    this.#resourceProofFingerprint = resourceProofFingerprint(selections);
    this.#resourceProofState = state;
    this.#resourceProofProblem = state === "unavailable" ? problem : undefined;
  }
}

function sharedMailboxes(
  mailboxes: readonly FeishuAccessibleMailbox[],
): readonly FeishuAccessibleMailbox[] {
  return mailboxes.filter((mailbox) => mailbox.type === SHARED_MAILBOX_TYPE);
}

function resourceProofFingerprint(
  selections: readonly ConnectorResourceSelection[],
): string {
  return canonicalJson(
    selections
      .map((selection) => ({
        connectionId: selection.connectionId,
        resourceId: selection.resourceId,
        resourceType: selection.resourceType,
        displayName: selection.displayName,
        address: selection.address,
        selectionId: selection.selectionId,
      }))
      .sort((left, right) =>
        `${left.resourceId}\u0000${left.selectionId}`.localeCompare(
          `${right.resourceId}\u0000${right.selectionId}`,
        ),
      ),
  );
}

function objectInput(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return value as Record<string, JsonValue>;
}

function integerInput(
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function enumString(
  value: JsonValue | undefined,
  allowed: readonly string[],
): string | undefined {
  return typeof value === "string" && allowed.includes(value)
    ? value
    : undefined;
}

function mailMessageJson(message: {
  readonly messageId: string;
  readonly threadId: string;
  readonly subject?: string;
  readonly from?: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly internalDate?: string;
  readonly folderId?: string;
  readonly labelIds: readonly string[];
  readonly bodyPreview?: string;
  readonly bodyPlainText?: string;
  readonly attachments: readonly {
    readonly name: string;
    readonly inline: boolean;
  }[];
  readonly security?: {
    readonly external: boolean;
    readonly risk: boolean;
    readonly banner?: string;
  };
}): JsonValue {
  const contact = (value: {
    readonly address: string;
    readonly name?: string;
  }): JsonValue => ({
    address: value.address,
    ...(value.name === undefined ? {} : { name: value.name }),
  });
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    ...(message.from === undefined ? {} : { from: contact(message.from) }),
    to: message.to.map(contact),
    cc: message.cc.map(contact),
    ...(message.internalDate === undefined
      ? {}
      : { internalDate: message.internalDate }),
    ...(message.folderId === undefined ? {} : { folderId: message.folderId }),
    labelIds: [...message.labelIds],
    ...(message.bodyPreview === undefined
      ? {}
      : { bodyPreview: message.bodyPreview }),
    ...(message.bodyPlainText === undefined
      ? {}
      : { bodyPlainText: message.bodyPlainText }),
    attachments: message.attachments.map((attachment) => ({
      name: attachment.name,
      inline: attachment.inline,
    })),
    ...(message.security === undefined
      ? {}
      : {
          security: {
            external: message.security.external,
            risk: message.security.risk,
            ...(message.security.banner === undefined
              ? {}
              : { banner: message.security.banner }),
          },
        }),
  };
}
