import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import {
  MAXIMUM_CONTROL_MESSAGE_BYTES,
  type MochiControlRequest,
  type MochiControlResponse,
  parseControlRequest,
  parseControlResponse,
} from "../../../src/control/protocol.ts";
import {
  bridgeProblem,
  DesktopFailure,
  fail,
  problem,
} from "../shared/problem.ts";
import { controlRequestTimeout } from "../shared/timing.ts";
import { exactFile } from "./contract.ts";

/** One fixed endpoint, one bounded request; no socket or arbitrary command crosses into React. */
export async function sendControl(
  path: string,
  request: MochiControlRequest,
): Promise<MochiControlResponse> {
  parseControlRequest(JSON.stringify(request));
  for (const [entry, kind, mode] of [
    [dirname(path), "directory", 0o700],
    [path, "socket", 0o600],
  ] as const) {
    if (!exactFile(entry, kind)) fail("control_unavailable");
    const stat = lstatSync(entry);
    if (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== mode)
      fail("control_unavailable");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: unknown, response?: MochiControlResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (response) resolve(response);
      else reject(error);
    };
    const deadline = setTimeout(
      () => finish(new DesktopFailure(problem("control_unavailable"))),
      controlRequestTimeout(request.command),
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        if (buffer.length > MAXIMUM_CONTROL_MESSAGE_BYTES)
          fail("control_response_invalid");
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        if (buffer.subarray(newline + 1).length)
          fail("control_response_invalid");
        let response: MochiControlResponse;
        try {
          response = parseControlResponse(
            buffer.subarray(0, newline).toString("utf8"),
            request.command,
          );
        } catch {
          fail("control_response_invalid");
        }
        if (!response.ok)
          throw new DesktopFailure(bridgeProblem(response.problem!));
        finish(undefined, response);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", () =>
      finish(new DesktopFailure(problem("control_unavailable"))),
    );
    socket.once("end", () => {
      if (!settled)
        finish(new DesktopFailure(problem("control_response_invalid")));
    });
  });
}
