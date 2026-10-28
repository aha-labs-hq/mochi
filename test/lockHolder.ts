/** Kills the one child holding this test's lock file, as an outside actor would. */
export function killLockHolder(path: string): void {
  const found = Bun.spawnSync(["/usr/sbin/lsof", "-t", "--", path]);
  const pids = found.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
  if (pids.length !== 1) throw new Error(`Expected one lock holder for ${path}, found ${pids.length}`);
  process.kill(pids[0]!, "SIGKILL");
}
