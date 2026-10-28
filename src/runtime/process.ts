import type { RuntimeConfig } from "../config.ts";

export function runtimeWorkerCommand(config: Pick<RuntimeConfig, "sudoPath" | "runtimeUser" | "workerPath">): string[] {
  return [
    config.sudoPath,
    "-n",
    "-H",
    "-u",
    config.runtimeUser,
    config.workerPath,
  ];
}

export function runtimeLauncherEnvironment(): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
  };
}
