/** Lossless build projection and renderer budget; neither is character content. */
export const ATLAS_COLUMNS = 8;
export const MOTION_BITMAP_BUDGET = 96 * 1024 * 1024;

/** Small clips stay one atlas; larger acting stages stream one row per page. */
export function atlasLayout(width: number, height: number, frames: number) {
  if (
    ![width, height, frames].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("Invalid motion pixel dimensions");
  const fullBytes =
    width * ATLAS_COLUMNS * height * Math.ceil(frames / ATLAS_COLUMNS) * 4;
  const framesPerPage =
    fullBytes <= MOTION_BITMAP_BUDGET / 2 ? frames : ATLAS_COLUMNS;
  const pageCount = Math.ceil(frames / framesPerPage);
  const bytes = atlasGeometry(
    width,
    height,
    Math.min(frames, framesPerPage),
  ).bytes;
  if (bytes > MOTION_BITMAP_BUDGET / 2)
    throw new Error("Motion page exceeds the bitmap memory budget");
  return { framesPerPage, pageCount, bytes };
}

export function atlasFilename(
  asset: string,
  pageCount: number,
  page: number,
): string {
  return pageCount === 1 ? `${asset}.atlas.png` : `${asset}.atlas.${page}.png`;
}

export function atlasGeometry(width: number, height: number, frames: number) {
  if (
    ![width, height, frames].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error("Invalid motion pixel dimensions");
  const atlasWidth = width * ATLAS_COLUMNS;
  const atlasHeight = height * Math.ceil(frames / ATLAS_COLUMNS);
  const bytes = atlasWidth * atlasHeight * 4;
  if (!Number.isSafeInteger(bytes) || bytes > MOTION_BITMAP_BUDGET)
    throw new Error("Motion atlas exceeds the bitmap memory budget");
  return { width: atlasWidth, height: atlasHeight, bytes };
}

/** Shared build/runtime limit: stable poses plus outgoing and incoming atlases. */
export function sequenceBitmapBudget(
  geometries: readonly { canvasWidth: number; canvasHeight: number }[],
  frames: number,
): number {
  if (!geometries.length) throw new Error("Character has no stable poses");
  let stableBytes = 0;
  let largestAtlas = 0;
  for (const { canvasWidth, canvasHeight } of geometries) {
    const atlas = atlasGeometry(canvasWidth, canvasHeight, frames);
    stableBytes += canvasWidth * canvasHeight * 4;
    largestAtlas = Math.max(largestAtlas, atlas.bytes);
  }
  if (stableBytes + largestAtlas * 2 > MOTION_BITMAP_BUDGET)
    throw new Error("Character exceeds motion bitmap budget");
  return MOTION_BITMAP_BUDGET - stableBytes;
}

/** Reserve before decoding; the displayed bitmap cannot be evicted. */
export class BitmapBudget<T extends { close(): void }> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private used = 0;
  constructor(readonly limit: number) {}
  get bytes() {
    return this.used;
  }
  get(id: string) {
    return this.entries.get(id)?.value;
  }
  reserve(bytes: number, pinned: string | readonly string[] | null): void {
    if (bytes > this.limit)
      throw new Error("Motion bitmap exceeds memory budget");
    for (const [id, entry] of this.entries) {
      if (this.used + bytes <= this.limit) return;
      if (id === pinned || (Array.isArray(pinned) && pinned.includes(id)))
        continue;
      entry.value.close();
      this.entries.delete(id);
      this.used -= entry.bytes;
    }
    if (this.used + bytes > this.limit)
      throw new Error("Motion transition exceeds memory budget");
  }
  put(id: string, value: T, bytes: number) {
    if (this.entries.has(id) || this.used + bytes > this.limit)
      throw new Error("Unreserved motion bitmap");
    this.entries.set(id, { value, bytes });
    this.used += bytes;
  }
  touch(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
  }
  clear() {
    for (const entry of this.entries.values()) entry.value.close();
    this.entries.clear();
    this.used = 0;
  }
}
