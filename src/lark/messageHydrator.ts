import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  AttachmentCapacityError,
  AttachmentStore,
  type AttachmentKind,
  type MessageArtifacts,
} from "../attachments/artifacts.ts";
import { detectMimeType, isUtf8Text } from "../attachments/content.ts";
import type { LarkMessageEvent } from "../domain.ts";
import { errorFields, log, type Logger } from "../log.ts";
import type { FeishuEvidenceMessage, FeishuTopicEvidence } from "./messageEvidence.ts";
import { decodeFeishuMessageContent, type MessageResourceReference } from "./messageContent.ts";
import { isSuccessfulLarkEnvelope, runLarkJson, type LarkContext } from "./process.ts";
import { FeishuReferenceReader, type FeishuReferenceSnapshot } from "./referenceReader.ts";

export type MessageDelivery = "handled" | "degraded";
export type MaterialSource = "current" | "reply" | "topic" | "recent";
export interface InputMessage extends FeishuEvidenceMessage {
  source: MaterialSource;
}
export interface HydratedMaterial {
  index: number;
  source: MaterialSource;
  sourceMessageId: string;
  kind: AttachmentKind | "reference";
  key?: string;
  url?: string;
  id?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  delivery: MessageDelivery;
  readability: "image" | "text" | "metadata";
  reason?: string;
  dataUrl?: string;
}
export interface HydratedFeishuMessage {
  /** The group's directory name when the turn was prepared; null is unknown, never guessed. */
  chatName: string | null;
  messageType: string;
  /** Exact accepted event text, retained for authorization; REST text is evidence only. */
  text: string;
  delivery: MessageDelivery;
  limitations: readonly string[];
  materials: readonly HydratedMaterial[];
  contextMessages: readonly InputMessage[];
  topicEvidence?: FeishuTopicEvidence;
  artifacts?: MessageArtifacts;
}
interface ResourceBytes {
  bytes: Uint8Array;
  sizeBytes: number;
  fileName?: string;
}
export interface LarkResourceReader {
  read(messageId: string, reference: MessageResourceReference, timeoutMilliseconds: number): Promise<ResourceBytes>;
}
export interface FeishuReferenceContentReader {
  read(url: string, timeoutMilliseconds: number): Promise<FeishuReferenceSnapshot>;
}
export const MATERIAL_PREPARATION_TIMEOUT_MILLISECONDS = 60_000;
const MAX_MESSAGE_CHARACTERS = 32_000;
const MAX_RESOURCE_COUNT = 8;
const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_RESOURCE_BYTES = 12 * 1024 * 1024;
const RESOURCE_DOWNLOAD_TIMEOUT_MILLISECONDS = 15_000;
const MAX_REFERENCE_COUNT = 4;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
export class FeishuMessageHydrator {
  constructor(
    context: LarkContext,
    stagingRoot: string,
    private readonly resources: LarkResourceReader = new CliResourceReader(context),
    private readonly artifacts = new AttachmentStore(stagingRoot),
    private readonly references: FeishuReferenceContentReader = new FeishuReferenceReader(context),
    private readonly logger: Logger = log,
  ) {}

  async hydrate(
    event: LarkMessageEvent,
    currentText: string,
    chatName: string | null,
    topicEvidence?: FeishuTopicEvidence,
    recent: { messages: readonly FeishuEvidenceMessage[]; limitations: readonly string[] } = {
      messages: [],
      limitations: [],
    },
    deadline = Date.now() + MATERIAL_PREPARATION_TIMEOUT_MILLISECONDS,
  ): Promise<HydratedFeishuMessage> {
    if (event.message_type === "system") throw new Error("System messages must not enter a model turn");
    const limitations = [...new Set([...(topicEvidence?.limitations ?? []), ...recent.limitations])];
    const contextMessages = inputMessages(event, topicEvidence, recent.messages);
    const materials: HydratedMaterial[] = [];
    const artifacts = this.artifacts.createMessageArtifacts();
    let totalBytes = 0;
    let resourceCount = 0;
    let referenceCount = 0;
    try {
      for (const source of contextMessages) {
        if (source.senderType !== "user" || source.deleted) continue;
        for (const reason of source.contentLimitations)
          materials.push({
            index: materials.length + 1,
            source: source.source,
            sourceMessageId: source.messageId,
            kind: "unknown",
            readability: "metadata",
            delivery: "degraded",
            reason,
          });
        for (const candidate of source.materialReferences) {
          const material: HydratedMaterial = {
            index: materials.length + 1,
            source: source.source,
            sourceMessageId: source.messageId,
            kind: candidate.kind,
            ...(candidate.key ? { key: candidate.key } : {}),
            ...(candidate.url ? { url: candidate.url } : {}),
            delivery: "degraded",
            readability: "metadata",
          };
          materials.push(material);
          const countExceeded = candidate.url
            ? ++referenceCount > MAX_REFERENCE_COUNT
            : ++resourceCount > MAX_RESOURCE_COUNT;
          if (countExceeded || Date.now() >= deadline) {
            material.reason = countExceeded ? "resource_count_limit" : "material_deadline_exceeded";
            continue;
          }
          try {
            let bytes: Uint8Array;
            let fileName: string | undefined;
            let mimeType: string;
            if (candidate.url) {
              const result = await this.references.read(candidate.url, deadline - Date.now());
              bytes = new TextEncoder().encode(JSON.stringify(result, null, 2));
              if (result.limitation) material.reason = result.limitation;
              fileName = `feishu-reference-${material.index}.json`;
              mimeType = "application/json; charset=utf-8";
            } else {
              if (candidate.kind === "reference") throw new Error("Reference URL is missing");
              const result = await this.resources.read(source.messageId, candidate, deadline - Date.now());
              material.sizeBytes = result.sizeBytes;
              if (result.sizeBytes > MAX_RESOURCE_BYTES) {
                material.reason = "resource_size_limit";
                continue;
              }
              bytes = result.bytes;
              fileName = result.fileName ?? candidate.fileName;
              mimeType = detectMimeType(bytes) ?? "application/octet-stream";
            }
            material.sizeBytes = bytes.byteLength;
            material.mimeType = mimeType;
            if (
              bytes.byteLength > (candidate.url ? MAX_REFERENCE_BYTES : MAX_RESOURCE_BYTES) ||
              totalBytes + bytes.byteLength > MAX_TOTAL_RESOURCE_BYTES
            ) {
              material.reason = "resource_size_limit";
              continue;
            }
            const artifact = artifacts.addAttachment({
              bytes,
              ...(fileName ? { fileName } : {}),
              kind: candidate.kind === "reference" ? "file" : candidate.kind,
              mimeType,
            });
            totalBytes += bytes.byteLength;
            material.id = artifact.id;
            material.fileName = artifact.fileName;
            material.readability = mimeType.startsWith("image/")
              ? "image"
              : isUtf8Text(bytes) && (mimeType.startsWith("text/") || mimeType.startsWith("application/json"))
                ? "text"
                : "metadata";
            if (material.readability === "image")
              material.dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
            if (material.readability === "metadata") material.reason = "content_reader_unavailable";
            material.delivery = material.reason ? "degraded" : "handled";
          } catch (error) {
            material.reason =
              error instanceof AttachmentCapacityError
                ? "active_attachment_capacity_limit"
                : "resource_read_failed";
            this.logger.warn("lark.material.degraded", {
              messageId: event.message_id,
              sourceMessageId: source.messageId,
              materialIndex: material.index,
              reason: material.reason,
              ...errorFields(error),
            });
          }
        }
      }
      for (const material of materials) {
        if (material.reason) addLimitation(limitations, `${material.sourceMessageId}:${material.reason}`);
      }
      const text = normalizeContent(currentText, limitations);
      const result: HydratedFeishuMessage = {
        chatName,
        messageType: event.message_type,
        text,
        delivery: limitations.length ? "degraded" : "handled",
        limitations,
        materials,
        contextMessages,
        ...(topicEvidence ? { topicEvidence } : {}),
      };
      if (artifacts.attachments.length) result.artifacts = artifacts;
      else artifacts.dispose();
      return result;
    } catch (error) {
      artifacts.dispose();
      throw error;
    }
  }
}

function inputMessages(
  event: LarkMessageEvent,
  evidence: FeishuTopicEvidence | undefined,
  recent: readonly FeishuEvidenceMessage[],
): InputMessage[] {
  const current = evidence?.messages.find((m) => m.messageId === event.message_id) ?? {
    messageId: event.message_id,
    chatId: event.chat_id,
    senderId: event.sender_id,
    senderType: event.sender_type,
    messageType: event.message_type,
    ...decodeFeishuMessageContent(event.message_type, event.content),
  };
  const replyIds = new Set(evidence?.referencedMessageIds ?? []);
  const messages: InputMessage[] = [
    { ...current, source: "current" },
    ...(evidence?.messages.filter((m) => replyIds.has(m.messageId)) ?? []).map((m) => ({
      ...m,
      source: "reply" as const,
    })),
    ...(evidence?.messages.filter((m) => !replyIds.has(m.messageId)).reverse() ?? []).map((m) => ({
      ...m,
      source: "topic" as const,
    })),
    ...[...recent].reverse().map((m) => ({ ...m, source: "recent" as const })),
  ];
  const seen = new Set<string>();
  return messages.filter((m) => {
    if (m.chatId !== event.chat_id) throw new Error("Input material source escaped the accepted chat");
    if (m.messageType === "system" || seen.has(m.messageId)) return false;
    seen.add(m.messageId);
    return true;
  });
}

class CliResourceReader implements LarkResourceReader {
  readonly #context: LarkContext;

  constructor(context: LarkContext) {
    this.#context = Object.freeze({ ...context });
  }

  async read(
    messageId: string,
    reference: MessageResourceReference,
    timeoutMilliseconds = RESOURCE_DOWNLOAD_TIMEOUT_MILLISECONDS,
  ): Promise<ResourceBytes> {
    const directory = mkdtempSync(join(tmpdir(), "mochi-resource-"));
    try {
      const envelope = await runLarkJson(
        this.#context,
        [
          "im",
          "+messages-resources-download",
          "--message-id",
          messageId,
          "--file-key",
          reference.key,
          "--type",
          reference.kind === "image" ? "image" : "file",
          "--output",
          "resource",
          "--format",
          "json",
          "--as",
          "bot",
        ],
        {
          cwd: directory,
          timeoutMilliseconds: Math.min(timeoutMilliseconds, RESOURCE_DOWNLOAD_TIMEOUT_MILLISECONDS),
        },
      );
      if (!isSuccessfulLarkEnvelope(envelope)) {
        throw new Error("lark-cli returned an unsuccessful resource envelope");
      }
      const data = record(record(envelope, "resource envelope").data, "resource envelope.data");
      if (typeof data.saved_path !== "string") throw new Error("lark-cli omitted resource saved_path");
      const path = realpathSync(resolve(directory, data.saved_path));
      const root = realpathSync(directory);
      const child = relative(root, path);
      if (!child || child.startsWith("..") || child.startsWith("/")) {
        throw new Error("lark-cli resource escaped its temporary directory");
      }
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("lark-cli resource output is not a file");
      if (stat.size > MAX_RESOURCE_BYTES) return { bytes: new Uint8Array(), sizeBytes: stat.size };
      return {
        bytes: readFileSync(path),
        sizeBytes: stat.size,
        fileName: reference.fileName ?? basename(path),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function normalizeContent(value: string, limitations: string[]): string {
  const text = value.replace(/\r\n/g, "\n").trim();
  if (text.length <= MAX_MESSAGE_CHARACTERS) return text;
  limitations.push("message_text_limit");
  return `${text.slice(0, MAX_MESSAGE_CHARACTERS)}\n…[消息文本已截断]`;
}

function addLimitation(limitations: string[], value: string): void {
  if (!limitations.includes(value)) limitations.push(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
