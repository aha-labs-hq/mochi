import { MotionCanvas } from "../src/motion/canvas.ts";
import type { MotionCatalog } from "../src/motion/catalog.ts";
import { StickerSurface } from "../src/motion/sticker.ts";

/** Exercise the actual atlas decoder, exposure selection and GPU material. */
export async function motionEvidence(catalog: MotionCatalog, id: string) {
  const sequence = catalog.sequence(id);
  const character = catalog.character(sequence.character);
  const source = document.createElement("canvas");
  const context = source.getContext("2d", { willReadFrequently: true })!;
  const output = document.createElement("canvas");
  let failure: unknown;
  const player = new MotionCanvas(context, catalog, character, (error) => {
    failure = error;
  });
  const surface = new StickerSurface(output, source, () => {
    failure = new Error("GPU material failed");
  });
  const gl = output.getContext("webgl2")!;
  const capture = () =>
    context.getImageData(0, 0, source.width, source.height).data;
  let maximumAlphaError = 0;
  let maximumColorError = 0;
  let fractionalRedraws = 0;
  const { frameCount } = catalog.timing(id);
  const ready = async (position: number) => {
    const deadline = performance.now() + 5_000;
    while (!player.ready(id, position)) {
      if (failure) throw failure;
      if (performance.now() >= deadline)
        throw new Error(`Atlas timeout: ${id}`);
      await new Promise(requestAnimationFrame);
    }
  };
  try {
    await player.prepare();
    player.draw({
      type: "asset",
      id: character.rootAsset,
      ...(sequence.stage ? { stage: sequence.stage } : {}),
    });
    const root = capture();
    let rootMismatch = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      await ready(frame);
      const changed = player.draw({ type: "sequence", id, position: frame });
      const original = capture();
      if (!frame)
        for (let i = 0; i < original.length; i++)
          if (original[i] !== root[i]) rootMismatch++;
      surface.draw(changed, false, false, true, frame);
      const values = new Uint8Array(source.width * source.height * 4);
      gl.readPixels(
        0,
        0,
        source.width,
        source.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        values,
      );
      for (let y = 0; y < source.height; y++)
        for (let x = 0; x < source.width; x++) {
          const from = (y * source.width + x) * 4;
          const to = ((source.height - y - 1) * source.width + x) * 4;
          const alpha = original[from + 3]!;
          maximumAlphaError = Math.max(
            maximumAlphaError,
            Math.abs(alpha - values[to + 3]!),
          );
          for (let channel = 0; channel < 3; channel++)
            maximumColorError = Math.max(
              maximumColorError,
              Math.abs(
                Math.round((original[from + channel]! * alpha) / 255) -
                  values[to + channel]!,
              ),
            );
        }
      if (
        frame < frameCount - 1 &&
        player.draw({ type: "sequence", id, position: frame + 0.5 })
      )
        fractionalRedraws++;
    }
    const terminal = capture();
    player.draw({
      type: "asset",
      id: sequence.targetAsset ?? character.rootAsset,
      ...(sequence.stage ? { stage: sequence.stage } : {}),
      end: true,
    });
    const hold = capture();
    let terminalMismatch = 0;
    for (let i = 0; i < terminal.length; i++)
      if (terminal[i] !== hold[i]) terminalMismatch++;
    if (failure) throw failure;
    return {
      frameCount,
      rootMismatch,
      terminalMismatch,
      maximumAlphaError,
      maximumColorError,
      fractionalRedraws,
    };
  } finally {
    surface.dispose();
    player.dispose();
  }
}
