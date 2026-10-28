import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp, { type Sharp } from "sharp";
import type { Plugin } from "vite";

/** One raster prepared for the page: the same widths in AVIF and WebP. */
export interface Picture {
  width: number;
  height: number;
  avif: string;
  webp: string;
  src: string;
}

type Format = "avif" | "webp" | "png";

const encoders: Record<Format, (image: Sharp) => Sharp> = {
  avif: (image) => image.avif({ quality: 58, effort: 5 }),
  webp: (image) => image.webp({ quality: 82, alphaQuality: 90, effort: 5 }),
  png: (image) => image.png({ compressionLevel: 9, palette: false }),
};

/**
 * `image.png?w=320,640&picture` imports a {@link Picture};
 * `image.png?w=180&png` imports the URL of one resized PNG (icons).
 * File names derive from the source bytes, so the client and server builds
 * agree on every URL. Both builds emit: most pictures belong to server-only
 * sections, and `build/site.ts` gathers the server build's assets.
 */
export function pictures(): Plugin {
  const encoded = new Map<string, Promise<Buffer>>();
  const encode = (file: string, width: number, format: Format) => {
    const key = `${file}:${width}:${format}`;
    const cached = encoded.get(key);
    if (cached) return cached;
    const pending = encoders[format](
      sharp(file).resize({ width, withoutEnlargement: true }),
    ).toBuffer();
    encoded.set(key, pending);
    return pending;
  };

  const emitted = new Set<string>();

  return {
    name: "mochi-pictures",
    enforce: "pre",
    buildStart() {
      emitted.clear();
    },
    async resolveId(source, importer) {
      const [path, query] = source.split("?");
      if (!query || !/&(picture|png)$/.test(query)) return null;
      const resolved = await this.resolve(path!, importer, { skipSelf: true });
      return resolved ? `${resolved.id}?${query}` : null;
    },
    async load(id) {
      const [file, query] = id.split("?");
      if (!file || !query || !/&(picture|png)$/.test(query)) return null;
      const params = new URLSearchParams(query);
      const source = await readFile(file);
      const digest = createHash("sha256")
        .update(source)
        .digest("hex")
        .slice(0, 10);
      const stem = basename(file, extname(file))
        .replace(/[^A-Za-z0-9-]/g, "-")
        .toLowerCase();
      const emit = async (width: number, format: Format) => {
        const fileName = `assets/${stem}-${digest}-${width}.${format}`;
        if (!emitted.has(fileName)) {
          emitted.add(fileName);
          this.emitFile({
            type: "asset",
            fileName,
            source: await encode(file, width, format),
          });
        }
        return `/${fileName}`;
      };

      const widths = (params.get("w") ?? "").split(",").map(Number);
      if (params.has("png")) {
        const width = widths[0]!;
        if (!Number.isSafeInteger(width) || width <= 0)
          throw new Error(`Invalid PNG width in ${id}`);
        return `export default ${JSON.stringify(await emit(width, "png"))};`;
      }

      const metadata = await sharp(source).metadata();
      if (!metadata.width || !metadata.height)
        throw new Error(`Unreadable picture ${file}`);
      if (!widths.every((w) => Number.isSafeInteger(w) && w > 0))
        throw new Error(`Invalid picture widths in ${id}`);
      const unique = [
        ...new Set(widths.map((width) => Math.min(width, metadata.width!))),
      ].sort((a, b) => a - b);
      const srcset = async (format: Format) =>
        (
          await Promise.all(
            unique.map(
              async (width) => `${await emit(width, format)} ${width}w`,
            ),
          )
        ).join(", ");
      const largest = unique.at(-1)!;
      const picture: Picture = {
        width: largest,
        height: Math.round((metadata.height * largest) / metadata.width),
        avif: await srcset("avif"),
        webp: await srcset("webp"),
        src: await emit(largest, "webp"),
      };
      return `export default ${JSON.stringify(picture)};`;
    },
  };
}
