import { expect, test } from "bun:test";
import { buttonStyles, cn } from "../src/ui/styles.ts";

test("Tailwind composition preserves typography and resolves variant conflicts", () => {
  expect(cn("text-xs", "text-ink")).toBe("text-xs text-ink");
  const duty = cn(buttonStyles({ variant: "duty" }), "px-5").split(" ");
  expect(duty).toContain("text-sm");
  expect(duty).toContain("text-primary");
  expect(duty).toContain("px-5");
  expect(duty).not.toContain("px-4");
  expect(duty).toContain("bg-control");
  expect(duty).toContain("rounded-md");
  expect(duty).toContain("compact:px-3");
  expect(duty).toContain("disabled:opacity-[.44]");
  expect(duty).toContain("control-focus");
});
