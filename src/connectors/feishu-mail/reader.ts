import { createHash } from "node:crypto";
import { type LarkContext, runLarkJson } from "../../lark/process.ts";

export const FEISHU_MAIL_MAX_THREADS = 20;
export const FEISHU_MAIL_MAX_MESSAGES = 40;
export const FEISHU_MAIL_MAX_TEXT_LENGTH = 20_000;
export const FEISHU_MAIL_MAX_ATTACHMENTS = 50;

export type FeishuMailReaderFailure =
  | "authorization_required"
  | "provider_unavailable"
  | "provider_response_invalid";

export class FeishuMailReaderError extends Error {
  readonly code: FeishuMailReaderFailure;

  constructor(code: FeishuMailReaderFailure, options?: { cause?: unknown }) {
    super(`Feishu mail reader: ${code}`, options);
    this.name = "FeishuMailReaderError";
    this.code = code;
  }
}

export interface FeishuMailIdentity {
  readonly accountId: string;
  readonly displayName: string;
  readonly grantedScopes: readonly string[];
}

export interface FeishuAccessibleMailbox {
  readonly address: string;
  readonly type: string | null;
}

export interface FeishuMailThreadSummary {
  readonly threadId: string;
  readonly preview?: string;
}

export interface FeishuMailContact {
  readonly address: string;
  readonly name?: string;
}

export interface FeishuMailMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly subject?: string;
  readonly from?: FeishuMailContact;
  readonly to: readonly FeishuMailContact[];
  readonly cc: readonly FeishuMailContact[];
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
}

export interface FeishuMailThread {
  readonly threadId: string;
  readonly messages: readonly FeishuMailMessage[];
}

export interface FeishuMailReader {
  /** Proves the explicitly selected user identity and returns its scope facts. */
  probe(): Promise<FeishuMailIdentity>;
  accessibleMailboxes(): Promise<readonly FeishuAccessibleMailbox[]>;
  listThreads(input: {
    readonly mailbox: string;
    readonly folder?: string;
    readonly onlyUnread?: boolean;
    readonly limit: number;
  }): Promise<readonly FeishuMailThreadSummary[]>;
  readThread(input: {
    readonly mailbox: string;
    readonly threadId: string;
    readonly includeSpamTrash?: boolean;
  }): Promise<FeishuMailThread>;
}

export interface FeishuMailReaderFactoryBinding extends LarkContext {}

/**
 * Uses only the official read endpoints. The command list is intentionally
 * closed: no send, reply, forward, draft, modify, delete or settings command
 * is reachable through this reader.
 */
export function createFeishuMailReader(
  binding: FeishuMailReaderFactoryBinding,
  run: typeof runLarkJson = runLarkJson,
): FeishuMailReader {
  const call = async (args: readonly string[]): Promise<unknown> => {
    try {
      return await run(binding, args);
    } catch (error) {
      throw new FeishuMailReaderError("provider_unavailable", { cause: error });
    }
  };

  return {
    async probe(): Promise<FeishuMailIdentity> {
      const value = await call(["auth", "status", "--verify", "--json"]);
      return parseIdentity(value);
    },

    async accessibleMailboxes(): Promise<readonly FeishuAccessibleMailbox[]> {
      const value = await call([
        "mail",
        "user_mailboxes",
        "accessible_mailboxes",
        "--params",
        JSON.stringify({ user_mailbox_id: "me" }),
        "--as",
        "user",
        "--json",
      ]);
      return parseAccessibleMailboxes(value);
    },

    async listThreads(input): Promise<readonly FeishuMailThreadSummary[]> {
      const limit = Math.max(
        1,
        Math.min(Math.floor(input.limit), FEISHU_MAIL_MAX_THREADS),
      );
      const params: Record<string, string | number | boolean> = {
        user_mailbox_id: input.mailbox,
        page_size: limit,
        // The Feishu API requires an explicit folder or label selector. The
        // connector's provider-neutral default is the inbox, so make that
        // default concrete at the transport boundary instead of relying on a
        // provider-side default that does not exist.
        folder_id: input.folder ?? "INBOX",
      };
      if (input.onlyUnread === true) params.only_unread = true;
      const value = await call([
        "mail",
        "user_mailbox.threads",
        "list",
        "--params",
        JSON.stringify(params),
        "--as",
        "user",
        "--json",
      ]);
      return parseThreadSummaries(value);
    },

    async readThread(input): Promise<FeishuMailThread> {
      const args = [
        "mail",
        "+thread",
        "--mailbox",
        input.mailbox,
        "--thread-id",
        input.threadId,
        "--html=false",
        "--format",
        "json",
        "--as",
        "user",
      ];
      if (input.includeSpamTrash === true) args.push("--include-spam-trash");
      const value = await call(args);
      return parseThread(value, input.threadId);
    },
  };
}

function parseIdentity(value: unknown): FeishuMailIdentity {
  const root = unwrap(value);
  const identities = record(root.identities) ? root.identities : undefined;
  const user =
    identities && record(identities.user) ? identities.user : undefined;
  // `auth status --verify` refreshes an expired access token, then has the
  // server verify it, yet still reports the stored pre-refresh state
  // ("needs_refresh") in status/tokenStatus (lark-cli 1.0.93
  // identitydiag.diagnoseUser). The user's own server verification is the
  // proof; the top-level `verified` belongs to whichever identity is effective.
  if (
    user?.verified !== true ||
    user.available !== true ||
    (user.status !== "ready" && user.status !== "needs_refresh")
  )
    throw new FeishuMailReaderError("authorization_required");
  const accountId = stringValue(user.openId) ?? stringValue(user.userId);
  if (!accountId) throw new FeishuMailReaderError("authorization_required");
  const displayName = stringValue(user.userName) ?? "飞书邮箱用户";
  const scope = Array.isArray(user.scope)
    ? user.scope.filter((item): item is string => typeof item === "string")
    : typeof user.scope === "string"
      ? user.scope.split(/\s+/).filter(Boolean)
      : [];
  return {
    accountId: boundedIdentifier(accountId),
    displayName: boundedText(displayName, 120),
    grantedScopes: [...new Set(scope)].sort(),
  };
}

function parseAccessibleMailboxes(
  value: unknown,
): readonly FeishuAccessibleMailbox[] {
  const root = unwrap(value);
  const raw = Array.isArray(root.accessible_mailboxes)
    ? root.accessible_mailboxes
    : Array.isArray(root.mailboxes)
      ? root.mailboxes
      : undefined;
  if (!raw) throw new FeishuMailReaderError("provider_response_invalid");
  const results: FeishuAccessibleMailbox[] = [];
  for (const item of raw.slice(0, 1_000)) {
    if (!record(item))
      throw new FeishuMailReaderError("provider_response_invalid");
    const address = normalizeMailboxAddress(
      item.email_address ?? item.mail_address,
    );
    if (!address) throw new FeishuMailReaderError("provider_response_invalid");
    const type = stringValue(item.email_type);
    results.push({ address, type: type ? boundedIdentifier(type) : null });
  }
  return deduplicateMailboxes(results);
}

function parseThreadSummaries(
  value: unknown,
): readonly FeishuMailThreadSummary[] {
  const root = unwrap(value);
  const raw = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.threads)
      ? root.threads
      : undefined;
  if (!raw) throw new FeishuMailReaderError("provider_response_invalid");
  return raw.slice(0, FEISHU_MAIL_MAX_THREADS).map((item) => {
    if (!record(item))
      throw new FeishuMailReaderError("provider_response_invalid");
    const threadId = stringValue(item.id) ?? stringValue(item.thread_id);
    if (!threadId) throw new FeishuMailReaderError("provider_response_invalid");
    const preview = stringValue(item.body_preview);
    return {
      threadId: boundedIdentifier(threadId, 256),
      ...(preview ? { preview: boundedText(decodeBody(preview), 1_000) } : {}),
    };
  });
}

function parseThread(
  value: unknown,
  requestedThreadId: string,
): FeishuMailThread {
  const root = unwrap(value);
  const thread = record(root.thread) ? root.thread : root;
  const threadId =
    stringValue(thread.id) ??
    stringValue(thread.thread_id) ??
    requestedThreadId;
  if (!threadId) throw new FeishuMailReaderError("provider_response_invalid");
  const rawMessages = Array.isArray(thread.messages)
    ? thread.messages
    : Array.isArray(root.messages)
      ? root.messages
      : [];
  if (!Array.isArray(rawMessages))
    throw new FeishuMailReaderError("provider_response_invalid");
  return {
    threadId: boundedIdentifier(threadId, 256),
    messages: rawMessages
      .slice(0, FEISHU_MAIL_MAX_MESSAGES)
      .map((item) => parseMessage(item, boundedIdentifier(threadId, 256))),
  };
}

function parseMessage(
  value: unknown,
  fallbackThreadId: string,
): FeishuMailMessage {
  if (!record(value))
    throw new FeishuMailReaderError("provider_response_invalid");
  const messageId = stringValue(value.message_id);
  if (!messageId) throw new FeishuMailReaderError("provider_response_invalid");
  const from = parseContact(value.head_from);
  const to = parseContacts(value.to);
  const cc = parseContacts(value.cc);
  const attachments = Array.isArray(value.attachments)
    ? value.attachments
        .slice(0, FEISHU_MAIL_MAX_ATTACHMENTS)
        .flatMap((item) => {
          if (!record(item)) return [];
          const name = stringValue(item.filename) ?? stringValue(item.name);
          return name
            ? [
                {
                  name: boundedText(name, 256),
                  inline: item.is_inline === true,
                },
              ]
            : [];
        })
    : [];
  const security = parseSecurity(value.security_level);
  return {
    messageId: boundedIdentifier(messageId, 256),
    threadId: boundedIdentifier(
      stringValue(value.thread_id) ?? fallbackThreadId,
      256,
    ),
    ...(stringValue(value.subject)
      ? { subject: boundedText(stringValue(value.subject)!, 1_000) }
      : {}),
    ...(from ? { from } : {}),
    to,
    cc,
    ...(value.internal_date !== undefined && value.internal_date !== null
      ? { internalDate: boundedText(String(value.internal_date), 64) }
      : {}),
    ...(stringValue(value.folder_id)
      ? { folderId: boundedIdentifier(stringValue(value.folder_id)!, 64) }
      : {}),
    labelIds: Array.isArray(value.label_ids)
      ? value.label_ids
          .filter((item): item is string => typeof item === "string")
          .slice(0, 64)
          .map((item) => boundedIdentifier(item, 128))
      : [],
    ...(stringValue(value.body_preview)
      ? {
          bodyPreview: boundedText(
            decodeBody(stringValue(value.body_preview)!),
            1_000,
          ),
        }
      : {}),
    ...(stringValue(value.body_plain_text)
      ? {
          bodyPlainText: boundedText(
            decodeBody(stringValue(value.body_plain_text)!),
            FEISHU_MAIL_MAX_TEXT_LENGTH,
          ),
        }
      : {}),
    attachments,
    ...(security ? { security } : {}),
  };
}

function parseContact(value: unknown): FeishuMailContact | undefined {
  if (!record(value)) return undefined;
  const address = normalizeMailboxAddress(
    value.mail_address ?? value.email_address,
  );
  if (!address) return undefined;
  const name = stringValue(value.name);
  return { address, ...(name ? { name: boundedText(name, 256) } : {}) };
}

function parseContacts(value: unknown): readonly FeishuMailContact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    const contact = parseContact(item);
    return contact ? [contact] : [];
  });
}

function parseSecurity(value: unknown): FeishuMailMessage["security"] {
  if (!record(value)) return undefined;
  const external = value.is_header_from_external === true;
  const risk = value.is_risk === true;
  const banner = stringValue(value.risk_banner_level);
  if (!external && !risk && !banner) return undefined;
  return {
    external,
    risk,
    ...(banner ? { banner: boundedIdentifier(banner, 32) } : {}),
  };
}

function unwrap(value: unknown): Record<string, unknown> {
  if (!record(value))
    throw new FeishuMailReaderError("provider_response_invalid");
  if (value.ok === false) {
    const error = record(value.error) ? value.error : undefined;
    const missingScopes =
      error && Array.isArray(error.missing_scopes)
        ? error.missing_scopes.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
    if (missingScopes.length > 0)
      throw new FeishuMailReaderError("authorization_required");
    throw new FeishuMailReaderError("provider_unavailable");
  }
  if (value.ok === true && record(value.data)) return value.data;
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n[内容已截断]`;
}

function boundedIdentifier(value: string, maximum = 256): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /\p{Cc}/u.test(trimmed)) {
    throw new FeishuMailReaderError("provider_response_invalid");
  }
  return trimmed;
}

export function normalizeMailboxAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const address = value.trim().toLowerCase();
  if (
    address.length < 3 ||
    address.length > 320 ||
    /\s|[<>(),;:\\"[\]]/.test(address) ||
    !/^[^@]+@[^@]+$/.test(address)
  )
    return undefined;
  return address;
}

function deduplicateMailboxes(
  mailboxes: readonly FeishuAccessibleMailbox[],
): readonly FeishuAccessibleMailbox[] {
  const seen = new Set<string>();
  return mailboxes.filter((mailbox) => {
    if (seen.has(mailbox.address)) return false;
    seen.add(mailbox.address);
    return true;
  });
}

/** Stable opaque resource token; the address remains only in the provider store. */
export function mailboxResourceToken(address: string): string {
  const normalized = normalizeMailboxAddress(address);
  if (!normalized) throw new Error("Invalid mailbox address");
  return createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function mailboxResourceId(address: string): string {
  return `mailbox:${mailboxResourceToken(address)}`;
}

export function parseMailboxResourceId(value: string): string | null {
  return /^mailbox:[a-f0-9]{32}$/.test(value)
    ? value.slice("mailbox:".length)
    : null;
}

function decodeBody(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9_-]+={0,2}$/.test(normalized)) return value;
  try {
    const decoded = Buffer.from(normalized, "base64url").toString("utf8");
    if (!decoded || /\p{Cc}/u.test(decoded.replace(/[\r\n\t]/g, "")))
      return value;
    const roundTrip = Buffer.from(decoded, "utf8")
      .toString("base64url")
      .replace(/=+$/, "");
    const input = normalized.replace(/=+$/, "");
    return roundTrip === input ? decoded : value;
  } catch {
    return value;
  }
}
