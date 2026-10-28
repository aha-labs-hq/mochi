/**
 * The offline maintenance commands, dispatched from one place.
 *
 * Every one of them either takes a lock on the deployment or reads only durable
 * files; none of them starts the Bridge, and none of them can be reached from the
 * control socket. They share this entry point so a new command cannot be added to
 * one launcher and forgotten in another.
 */
export const PRODUCT_COMMANDS = [
  "--validate-github-registration",
  "doctor",
  "service",
  "runtime:contract",
  "runtime:session:init",
  "runtime:session:migrate",
  "runtime:account:adopt",
  "bot:list",
] as const;

export type ProductCommand = (typeof PRODUCT_COMMANDS)[number];

export function isProductCommand(value: string): value is ProductCommand {
  return (PRODUCT_COMMANDS as readonly string[]).includes(value);
}

export async function runProductCommand(
  command: ProductCommand,
  args: readonly string[],
): Promise<void> {
  switch (command) {
    case "--validate-github-registration": return (await import("./github/registration.ts")).runValidation(args);
    case "doctor": return (await import("./maintenance/doctor.ts")).run(args);
    case "service": return (await import("./maintenance/service.ts")).run(args);
    case "runtime:contract": return (await import("./maintenance/runtimeContract.ts")).run(args);
    case "runtime:session:init": return (await import("./maintenance/initRuntimeSession.ts")).run(args);
    case "runtime:session:migrate": return (await import("./maintenance/migrateRuntimeSession.ts")).run(args);
    case "runtime:account:adopt": return (await import("./maintenance/adoptRuntimeAccount.ts")).run(args);
    case "bot:list": return (await import("./product/fleet.ts")).runList(args);
  }
}
