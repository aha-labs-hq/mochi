/** The official CLI's compact message contract is decoded once, before any
 * display-text budget. Downstream material delivery never reparses clipped text.
 * Contract: larksuite/cli v1.0.93, shortcuts/im/convert_lib/{media,text,merge}.go.
 */
export interface MessageResourceReference {
  kind: "image" | "file" | "audio" | "video";
  key: string;
  fileName?: string;
  url?: never;
}
export type MessageMaterialReference = MessageResourceReference | {
  kind: "reference";
  url: string;
  key?: never;
  fileName?: never;
};
export interface FeishuMessageContent {
  text: string;
  materialReferences: readonly MessageMaterialReference[];
  contentLimitations: readonly string[];
}

const MAX_MATERIAL_REFERENCES = 64;
const RESOURCE_TYPES = new Set(["post", "image", "file", "audio", "media", "video", "merge_forward"]);
const KNOWN_TYPES = new Set([
  "text", ...RESOURCE_TYPES, "sticker", "interactive", "share_chat", "share_user", "location",
  "folder", "share_calendar_event", "calendar", "general_calendar", "video_chat", "todo", "vote", "hongbao",
]);

export function decodeFeishuMessageContent(messageType: string, text: string): FeishuMessageContent {
  const materialReferences: MessageMaterialReference[] = [];
  const limitations = new Set<string>();
  const seen = new Set<string>();
  const add = (reference: MessageMaterialReference): void => {
    const identity = reference.key ?? reference.url;
    if (seen.has(identity)) return;
    if (materialReferences.length === MAX_MATERIAL_REFERENCES) {
      limitations.add("message_material_reference_limit");
      return;
    }
    seen.add(identity);
    materialReferences.push(reference);
  };

  if (!KNOWN_TYPES.has(messageType)) limitations.add("unknown_message_type");
  if (messageType === "sticker") limitations.add("sticker_resource_unavailable");
  if (messageType === "interactive") limitations.add("card_visual_content_unavailable");
  if (messageType === "folder") limitations.add("folder_content_unavailable");
  if (messageType === "merge_forward" && /^\[Merged forward[^\n]*\]$/.test(text.trim())) {
    limitations.add("forward_content_unavailable");
  }

  if (RESOURCE_TYPES.has(messageType)) {
    // Standalone images and post media are bracket markers; post images are
    // Markdown; files/audio/video and attachment zones use CLI attribute tags.
    // The official forward expansion contains these same representations.
    const tokens = text.matchAll(
      /!\[[^\[\]\r\n]*\]\((img_[A-Za-z0-9_-]+)\)|\[(Image|Media)(?:: ([^\[\]\r\n]*))?\]|<(img|file|audio|media|video|folder)\b((?:[^<>"\\]|"(?:\\.|[^"\\])*")*)>/g,
    );
    for (const match of tokens) {
      const tag = match[4];
      if (tag === "folder") { limitations.add("folder_content_unavailable"); continue; }
      const attributes = match[5] ?? "";
      const key = match[1] ?? match[3] ?? attribute(attributes, "key");
      const kind = match[1] || match[2] === "Image" || tag === "img" ? "image"
        : match[2] === "Media" || tag === "media" || tag === "video" ? "video"
        : tag === "audio" ? "audio" : "file";
      if (!key || !(kind === "image" ? /^img_[A-Za-z0-9_-]+$/ : /^file_[A-Za-z0-9_-]+$/).test(key)) {
        limitations.add("resource_reference_missing");
        continue;
      }
      const fileName = attribute(attributes, "name");
      add({ kind, key, ...(fileName ? { fileName } : {}) });
    }
    if (["image", "file", "audio", "media", "video"].includes(messageType) && !materialReferences.length) {
      limitations.add("resource_reference_missing");
    }
  }

  for (const match of text.matchAll(/https:\/\/[^\s<>\])}"']+/g)) {
    const url = match[0].replace(/[.,;:!?，。；：！？]+$/u, "");
    if (isFeishuUrl(url)) add({ kind: "reference", url });
  }
  return { text, materialReferences, contentLimitations: [...limitations] };
}

function attribute(attributes: string, name: string): string | undefined {
  // cardEscapeAttr uses backslash escaping, not XML entities. Consume whole
  // quoted values so names containing quotes, tags or `key=` remain one value.
  for (const match of attributes.matchAll(/(?:^|\s)([a-z_]+)="((?:\\.|[^"\\])*)"/g)) {
    if (match[1] === name) return match[2]!.replace(/\\([\\"nrt])/g, (_, escaped: string) =>
      ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped]!);
  }
  return undefined;
}

function isFeishuUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["feishu.cn", "larksuite.com", "larkoffice.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}
