/**
 * The Bridge entry point.
 *
 * Every offline action is dispatched here, before any product object exists, so a
 * maintenance command can never race a running deployment: it either takes the
 * deployment lock and runs alone, or it reports that Mochi is already running.
 */
import { Bridge } from "./bridge.ts";
import { isProductCommand, runProductCommand } from "./maintenance.ts";
import { productProblem } from "./control/productProblem.ts";
import { errorFields, log } from "./log.ts";
import { BRIDGE_VERSION } from "./product/version.ts";

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write(`mochi-bridge ${BRIDGE_VERSION}\n`);
} else if (process.argv.length >= 3 && isProductCommand(process.argv[2]!)) {
  const command = process.argv[2]!;
  const args = process.argv.slice(3);
  runProductCommand(command, args).catch((error: unknown) => {
    log.error("bridge.maintenance_failed", { command, ...errorFields(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (process.argv.length !== 2) {
  console.error("Unsupported Mochi command");
  process.exitCode = 1;
} else {
  const bridge = new Bridge();
  const stop = () => {
    void bridge.stop().catch((error) => {
      log.error("bridge.shutdown_failed", errorFields(error));
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  bridge.start().catch(async (error: unknown) => {
    log.error("bot.fatal", {
      ...errorFields(error),
      problem: productProblem("bridge_startup_failed"),
    });
    try {
      bridge.fail("bridge_startup_failed");
    } catch (statusError) {
      log.error("bot.status_projection_failed", errorFields(statusError));
    }
    await bridge.stop();
    process.exitCode = 1;
  });
}
