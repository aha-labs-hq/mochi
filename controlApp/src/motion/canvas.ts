import type { Character, MotionCatalog } from "./catalog.ts";
import {
  ATLAS_COLUMNS,
  atlasFilename,
  atlasGeometry,
  atlasLayout,
  BitmapBudget,
  sequenceBitmapBudget,
} from "./resources.ts";
import type { FramePose } from "./timeline.ts";

/** Losslessly decoded atlases are a build projection, not another motion manifest. */
export class MotionCanvas {
  private readonly assets = new Map<string, ImageBitmap>();
  private readonly sequences: BitmapBudget<ImageBitmap>;
  private loading = false;
  private disposed = false;
  private previousPose: FramePose | null = null;
  constructor(
    private readonly context: CanvasRenderingContext2D,
    private readonly catalog: MotionCatalog,
    private readonly character: Character,
    private readonly onFailure: (error: unknown) => void,
    private readonly load: (path: string) => Promise<ImageBitmap> = loadBitmap,
  ) {
    this.sequences = new BitmapBudget(
      sequenceBitmapBudget(
        character.assets.map((asset) => asset.geometry),
        catalog.manifest.production.frameCount,
      ),
    );
  }
  async prepare(): Promise<void> {
    for (const asset of this.character.assets) {
      if (this.disposed) return;
      const image = await this.load(`./assets/${asset.resource}.png`);
      if (
        image.width !== asset.geometry.canvasWidth ||
        image.height !== asset.geometry.canvasHeight
      ) {
        image.close();
        throw new Error("Stable motion dimensions do not match the manifest");
      }
      if (this.disposed) image.close();
      else this.assets.set(asset.id, image);
    }
  }
  private pages(id: string, position: number) {
    const sequence = this.catalog.sequence(id);
    const geometry = this.catalog.sequenceGeometry(sequence);
    const frames = this.catalog.timing(id).frameCount;
    if (!Number.isFinite(position) || position < 0 || position > frames - 1)
      throw new Error("Invalid motion frame position");
    const layout = atlasLayout(
      geometry.canvasWidth,
      geometry.canvasHeight,
      frames,
    );
    const lower = Math.floor(position);
    return {
      sequence,
      geometry,
      layout,
      pages: [Math.floor(lower / layout.framesPerPage)],
    };
  }
  ready = (id: string, position = 0): boolean => {
    if (this.disposed) return false;
    const { sequence, geometry, layout, pages } = this.pages(id, position);
    const available = pages.every((page) =>
      this.sequences.get(`${id}:${page}`),
    );
    const missing = pages.find((page) => !this.sequences.get(`${id}:${page}`));
    // State exits run backwards. Prefetch in the actual playback direction so
    // a reverse page boundary does not have to stop the video for decoding.
    const displayed = this.previousPose;
    const reversing =
      displayed?.type === "sequence" &&
      displayed.id === id &&
      position < displayed.position;
    const local = position % layout.framesPerPage;
    const ahead =
      reversing && local < 3
        ? pages[0]! - 1
        : !reversing && local >= layout.framesPerPage - 3
          ? pages[0]! + 1
          : null;
    const page =
      missing ??
      (ahead !== null &&
      ahead >= 0 &&
      ahead < layout.pageCount &&
      !this.sequences.get(`${id}:${ahead}`)
        ? ahead
        : null);
    if (page !== null && !this.loading) {
      const expected = atlasGeometry(
        geometry.canvasWidth,
        geometry.canvasHeight,
        Math.min(
          layout.framesPerPage,
          this.catalog.timing(id).frameCount - page * layout.framesPerPage,
        ),
      );
      const pinned =
        displayed?.type === "sequence"
          ? this.pages(displayed.id, displayed.position).pages.map(
              (p) => `${displayed.id}:${p}`,
            )
          : [];
      this.sequences.reserve(expected.bytes, pinned);
      this.loading = true;
      void this.load(
        `./assets/${atlasFilename(sequence.asset, layout.pageCount, page)}`,
      )
        .then((image) => {
          if (this.disposed) {
            image.close();
            return;
          }
          if (
            image.width !== expected.width ||
            image.height !== expected.height
          ) {
            image.close();
            throw new Error(
              "Motion atlas dimensions do not match the manifest",
            );
          }
          this.sequences.put(`${id}:${page}`, image, expected.bytes);
        })
        .catch(this.onFailure)
        .finally(() => {
          this.loading = false;
        });
    }
    return available;
  };
  draw(pose: FramePose): boolean {
    if (
      this.previousPose?.type === pose.type &&
      this.previousPose.id === pose.id &&
      ((pose.type === "asset" &&
        this.previousPose.type === "asset" &&
        this.previousPose.stage === pose.stage &&
        this.previousPose.end === pose.end) ||
        (pose.type === "sequence" &&
          this.previousPose.type === "sequence" &&
          Math.floor(this.previousPose.position) === Math.floor(pose.position)))
    )
      return false;
    this.previousPose = pose;
    const context = this.context,
      canvas = context.canvas;
    const size =
      pose.type === "sequence"
        ? this.catalog.sequenceGeometry(this.catalog.sequence(pose.id))
        : pose.stage
          ? { canvasWidth: pose.stage.size, canvasHeight: pose.stage.size }
          : this.catalog.asset(this.character, pose.id).geometry;
    // Decode and composite at the declared stage resolution. A larger acting
    // stage must not silently halve the fur resolution in the old root canvas.
    if (
      canvas.width !== size.canvasWidth ||
      canvas.height !== size.canvasHeight
    ) {
      canvas.width = size.canvasWidth;
      canvas.height = size.canvasHeight;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    if (pose.type === "asset") {
      const image = this.assets.get(pose.id);
      if (!image) throw new Error("Stable motion asset unavailable");
      if (pose.stage) {
        const origin = pose.end ? pose.stage.end : pose.stage.start;
        context.drawImage(
          image,
          (origin.x / pose.stage.size) * canvas.width,
          (origin.y / pose.stage.size) * canvas.height,
          (image.width / pose.stage.size) * canvas.width,
          (image.height / pose.stage.size) * canvas.height,
        );
      } else context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return true;
    }
    const sequence = this.catalog.sequence(pose.id);
    const geometry = this.catalog.sequenceGeometry(sequence);
    const { frameCount } = this.catalog.timing(pose.id);
    const layout = atlasLayout(
      geometry.canvasWidth,
      geometry.canvasHeight,
      frameCount,
    );
    // Preserve every generated exposure. Even a slow prop creates two
    // translucent silhouettes when adjacent frames are dissolved together.
    // The timeline remains fractional; the image follows the source cadence.
    const draw = (frame: number) => {
      const page = Math.floor(frame / layout.framesPerPage);
      const local = frame % layout.framesPerPage;
      const key = `${pose.id}:${page}`;
      const atlas = this.sequences.get(key);
      if (!atlas) throw new Error("Generated motion page unavailable");
      this.sequences.touch(key);
      context.drawImage(
        atlas,
        (local % ATLAS_COLUMNS) * geometry.canvasWidth,
        Math.floor(local / ATLAS_COLUMNS) * geometry.canvasHeight,
        geometry.canvasWidth,
        geometry.canvasHeight,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    draw(Math.floor(pose.position));
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    return true;
  }
  dispose(): void {
    this.disposed = true;
    for (const image of this.assets.values()) image.close();
    this.assets.clear();
    this.sequences.clear();
  }
}

async function loadBitmap(path: string): Promise<ImageBitmap> {
  // Packaged views:// resources are images, not HTTP responses. Decode through
  // the browser's native image path without inventing HTTP status semantics.
  const image = new Image();
  image.src = path;
  await image.decode();
  return createImageBitmap(image);
}
