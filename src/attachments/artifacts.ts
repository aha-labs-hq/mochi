import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

export type AttachmentKind = "image" | "file" | "audio" | "video" | "unknown";

export interface AttachmentArtifact {
  id: string;
  path: string;
  fileName: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
}

export class AttachmentCapacityError extends Error {
  constructor() {
    super("The active attachment workspace capacity has been reached");
    this.name = "AttachmentCapacityError";
  }
}

export class AttachmentStore {
  readonly #maximumBytes: number;
  readonly #root: string;
  #allocatedBytes = 0;

  constructor(root: string, maximumBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Attachment store maximumBytes must be a positive safe integer");
    }
    this.#maximumBytes = maximumBytes;
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    chmodSync(this.#root, 0o700);
  }

  createMessageArtifacts(): MessageArtifacts {
    return new MessageArtifacts(
      (sizeBytes) => {
        if (this.#allocatedBytes + sizeBytes > this.#maximumBytes) {
          throw new AttachmentCapacityError();
        }
        this.#allocatedBytes += sizeBytes;
      },
      (sizeBytes) => {
        this.#allocatedBytes -= sizeBytes;
      },
      this.#root,
    );
  }

  get allocatedBytes(): number {
    return this.#allocatedBytes;
  }
}

export class MessageArtifacts {
  readonly #directory: string;
  readonly #reserve: (sizeBytes: number) => void;
  readonly #release: (sizeBytes: number) => void;
  readonly #attachments = new Map<string, AttachmentArtifact>();
  #allocatedBytes = 0;
  #disposed = false;

  constructor(
    reserve: (sizeBytes: number) => void,
    release: (sizeBytes: number) => void,
    root: string,
  ) {
    this.#directory = mkdtempSync(join(root, "message-"));
    this.#reserve = reserve;
    this.#release = release;
  }

  addAttachment(input: {
    bytes: Uint8Array;
    fileName?: string;
    kind: AttachmentKind;
    mimeType: string;
  }): AttachmentArtifact {
    this.#assertActive();
    this.#reserve(input.bytes.byteLength);
    this.#allocatedBytes += input.bytes.byteLength;
    try {
      const id = `attachment_${randomUUID()}`;
      const fileName = safeFileName(input.fileName, input.mimeType);
      const path = join(this.#directory, id);
      writeFileSync(path, input.bytes, { mode: 0o444, flag: "wx" });
      chmodSync(path, 0o444);
      const artifact: AttachmentArtifact = {
        id,
        path,
        fileName,
        kind: input.kind,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
      };
      this.#attachments.set(id, artifact);
      return artifact;
    } catch (error) {
      this.#allocatedBytes -= input.bytes.byteLength;
      this.#release(input.bytes.byteLength);
      throw error;
    }
  }

  attachment(id: string): AttachmentArtifact | undefined {
    return this.#disposed ? undefined : this.#attachments.get(id);
  }

  get attachments(): readonly AttachmentArtifact[] {
    return this.#disposed ? [] : [...this.#attachments.values()];
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    rmSync(this.#directory, { recursive: true, force: true });
    this.#release(this.#allocatedBytes);
    this.#allocatedBytes = 0;
    this.#attachments.clear();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Message artifacts have already been disposed");
  }
}

export function resetMaterialStaging(root: string): void {
  const resolved = resolve(root);
  rmSync(resolved, { recursive: true, force: true });
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  chmodSync(resolved, 0o700);
}

function safeFileName(value: string | undefined, mimeType: string): string {
  const input = value ? basename(value).normalize("NFC") : "attachment";
  const sanitized = input
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .trim()
    .slice(0, 120);
  if (sanitized && extname(sanitized)) return sanitized;
  return `${sanitized || "attachment"}${extensionFor(mimeType)}`;
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "application/pdf": return ".pdf";
    case "application/zip": return ".zip";
    case "text/plain; charset=utf-8": return ".txt";
    case "application/json; charset=utf-8": return ".json";
    default: return "";
  }
}
