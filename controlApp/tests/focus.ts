import { expect, type Locator } from "@playwright/test";

/**
 * The keyboard focus contract: a visible neutral ring outside the control, at
 * least 3:1 against what surrounds it, that neither moves nor resizes it and is
 * unlike the selection wash. Colors are resolved by the browser itself, so any
 * CSS color syntax compares correctly.
 */
export async function expectFocusRing(
  control: Locator,
  /** The element that draws the ring, when focus lands on a child input. */
  ringOwner: Locator = control,
) {
  const resting = await ringOwner.evaluate((node) =>
    node.getBoundingClientRect().toJSON(),
  );
  await control.focus();
  await expect(control).toBeFocused();
  const ring = await ringOwner.evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const pixel = (color: string, under?: number[]) => {
      context.clearRect(0, 0, 1, 1);
      if (under) {
        context.fillStyle = `rgb(${under.join(",")})`;
        context.fillRect(0, 0, 1, 1);
      }
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    // The nearest opaque surface behind the control; the page is white.
    let background = [255, 255, 255];
    for (
      let element = node.parentElement;
      element;
      element = element.parentElement
    ) {
      const [r, g, b, a] = pixel(getComputedStyle(element).backgroundColor);
      if (a === 255) {
        background = [r!, g!, b!];
        break;
      }
    }
    const style = getComputedStyle(node);
    const [r, g, b] = pixel(style.outlineColor, background);
    const luminance = ([red, green, blue]: number[]) =>
      [red!, green!, blue!]
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.03928
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!,
          0,
        );
    const [light, dark] = [luminance([r!, g!, b!]), luminance(background)].sort(
      (a, b) => b - a,
    );
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      offset: Number.parseFloat(style.outlineOffset),
      contrast: (light! + 0.05) / (dark! + 0.05),
      neutral: Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 8,
      rect: node.getBoundingClientRect().toJSON(),
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.offset).toBeGreaterThanOrEqual(1);
  expect(ring.contrast).toBeGreaterThanOrEqual(3);
  expect(ring.neutral).toBe(true);
  expect(ring.rect).toEqual(resting);
}
