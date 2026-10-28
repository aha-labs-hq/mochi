import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { UPDATE_SERVICE_SOCKET } from "../../../src/product/installation.ts";
import type { UpdatePhase } from "../shared/updates.ts";

export interface UpdateServiceState {
  version: 1;
  phase: UpdatePhase | "cancelling";
  mode?: "uninstall" | "repair";
  targetVersion?: string;
  candidateSha256?: string;
  error?: string;
}
const phases = new Set([
  "idle",
  "preparing",
  "waiting",
  "closing",
  "installing",
  "verifying",
  "restoring",
  "restored",
  "completed",
  "failed",
  "cancelling",
]);
export async function updateService(
  command: "status" | "cancel" | "install" | "uninstall",
  candidateSha256?: string,
  policy?: "keepData" | "deleteAll",
): Promise<UpdateServiceState> {
  const socket = lstatSync(UPDATE_SERVICE_SOCKET);
  if (!socket.isSocket() || socket.uid !== 0 || socket.isSymbolicLink())
    throw Error("update_service_untrusted");
  return new Promise((resolve, reject) => {
    let bytes = "";
    const client = createConnection(UPDATE_SERVICE_SOCKET);
    const timer = setTimeout(
      () => client.destroy(Error("update_service_timeout")),
      15_000,
    );
    client.once("connect", () =>
      client.write(
        `${JSON.stringify({ version: 1, command, ...(candidateSha256 ? { candidateSha256 } : {}), ...(policy ? { policy } : {}) })}\n`,
      ),
    );
    client.on("data", (chunk) => {
      bytes += chunk.toString("utf8");
      if (bytes.length > 65536) {
        client.destroy(Error("update_service_invalid"));
        return;
      }
      if (!bytes.includes("\n")) return;
      try {
        const value = JSON.parse(bytes.split("\n")[0]!);
        if (
          value?.version !== 1 ||
          !phases.has(value.phase) ||
          Object.keys(value).some(
            (key) =>
              ![
                "version",
                "phase",
                "targetVersion",
                "candidateSha256",
                "error",
                "mode",
              ].includes(key),
          ) ||
          (value.mode !== undefined &&
            value.mode !== "uninstall" &&
            value.mode !== "repair") ||
          (value.targetVersion !== undefined &&
            (typeof value.targetVersion !== "string" ||
              value.targetVersion.length > 64 ||
              !/^\d+\.\d+\.\d+$/.test(value.targetVersion))) ||
          (value.candidateSha256 !== undefined &&
            (typeof value.candidateSha256 !== "string" ||
              !/^[a-f0-9]{64}$/.test(value.candidateSha256))) ||
          (value.error !== undefined &&
            (typeof value.error !== "string" ||
              !/^[a-zA-Z]{1,32}$/.test(value.error)))
        )
          throw Error("update_service_invalid");
        resolve(value);
        client.end();
      } catch {
        client.destroy(Error("update_service_invalid"));
      }
    });
    client.once("error", reject);
    client.once("close", () => {
      clearTimeout(timer);
      reject(Error("update_service_closed"));
    });
  });
}
