import { fail } from "../shared/problem.ts";
import type { CommandRunner } from "./process.ts";

interface ProcessRecord {
  pid: number;
  parent: number;
  started: string;
}

/** Read only process identity, never arguments or environment. Birth time keeps
 * a reused PID from being mistaken for a surviving Mochi process. */
export async function processTable(
  command: CommandRunner,
): Promise<ProcessRecord[]> {
  const result = await command(["/bin/ps", "-axo", "pid=,ppid=,lstart="]);
  if (result.code !== 0) fail("service_shutdown_failed");
  return result.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) fail("service_shutdown_failed");
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        started: match[3]!.replace(/\s+/g, " "),
      };
    });
}

/** Retain the verified Bridge's descendants across reparenting, including the
 * detached Lark bus. This observes completion; it never kills arbitrary PIDs. */
export class ProcessFamily {
  private readonly identities = new Map<number, string>();
  constructor(root: number | undefined, table: readonly ProcessRecord[]) {
    this.include(root, table);
  }
  include(root: number | undefined, table: readonly ProcessRecord[]): void {
    const record = table.find((entry) => entry.pid === root);
    if (record) this.identities.set(record.pid, record.started);
    this.remaining(table);
  }
  remaining(table: readonly ProcessRecord[]): number {
    const live = new Set(
      table
        .filter((entry) => this.identities.get(entry.pid) === entry.started)
        .map((entry) => entry.pid),
    );
    let added: boolean;
    do {
      added = false;
      for (const entry of table) {
        if (!live.has(entry.pid) && live.has(entry.parent)) {
          this.identities.set(entry.pid, entry.started);
          live.add(entry.pid);
          added = true;
        }
      }
    } while (added);
    return live.size;
  }
}
