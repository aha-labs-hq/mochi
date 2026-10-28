export function detectMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || startsWith(bytes, [0xff, 0xfb])) return "audio/mpeg";
  if (isUtf8Text(bytes)) return "text/plain; charset=utf-8";
  return undefined;
}

export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const controlCharacters = [...text].filter((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    }).length;
    return controlCharacters <= Math.max(1, Math.floor(text.length / 100));
  } catch {
    return false;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** Content, never a caller-controlled extension, determines the worker representation. */
export function materialContent(
  bytes: Uint8Array,
  offset = 0,
): {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: { bytes: number; nextOffset?: number; totalCharacters?: number };
} {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Material offset must be a non-negative integer");
  const mimeType = detectMimeType(bytes);
  if (mimeType?.startsWith("image/")) {
    if (offset !== 0) throw new Error("Images do not accept a text offset");
    return {
      content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType }],
      details: { bytes: bytes.length },
    };
  }
  if (!mimeType?.startsWith("text/")) {
    throw new Error("This binary format has no content reader; only its metadata is available");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (offset > text.length) throw new Error("Material offset exceeds text length");
  let end = Math.min(text.length, offset + 120_000);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  const nextOffset = end < text.length ? end : undefined;
  return {
    content: [
      {
        type: "text",
        text:
          text.slice(offset, end) + (nextOffset === undefined ? "" : `\n[继续读取：offset=${nextOffset}]`),
      },
    ],
    details: {
      bytes: bytes.length,
      totalCharacters: text.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    },
  };
}
