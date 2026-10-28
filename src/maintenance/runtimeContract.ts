import { loadBotConfig, loadRuntimeConfig } from "../config.ts";
import { mochiControlManifest } from "../control/manifest.ts";
import { botArgument } from "./types.ts";
import { selectBotLayout } from "../product/fleet.ts";
import { runtimeWorkerCommand } from "../runtime/process.ts";
import { productVersion } from "../product/version.ts";

export async function run(argv: readonly string[]): Promise<void> {
  if (argv.includes("--control-manifest")) {
    const mode = argv.at(argv.indexOf("--control-manifest") + 1);
    if (mode !== "development" && mode !== "installed") {
      throw new Error("--control-manifest requires development or installed");
    }
    process.stdout.write(`${JSON.stringify(mochiControlManifest(mode, productVersion()))}\n`);
    return;
  }
  const json = "--json";
  const layout = selectBotLayout(botArgument(argv, "runtime:contract", [json]));
  const command = runtimeWorkerCommand(loadRuntimeConfig(loadBotConfig(layout), layout.botId));
  process.stdout.write(argv.includes(json)
    ? `${JSON.stringify(command)}\n`
    : `${command.map(shellArgument).join(" ")}\n`);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
