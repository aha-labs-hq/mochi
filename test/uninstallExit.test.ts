import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { installationManifest } from "../src/product/installation.ts";

const lifecycle = join(import.meta.dir, "../installer/lifecycle.sh");
let directory: string;
let executable: string;
const children: ReturnType<typeof Bun.spawn>[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mochi-uninstall-exit-"));
  executable = join(directory, "fixture");
  const source = join(directory, "fixture.c");
  await writeFile(source, `#include <signal.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1) signal(SIGTERM, SIG_IGN);
  puts("ready"); fflush(stdout);
  for (;;) pause();
}
`);
  const compiler = Bun.spawn(["/usr/bin/cc", source, "-o", executable], { stderr: "pipe" });
  const code = await compiler.exited;
  expect(await new Response(compiler.stderr).text()).toBe("");
  expect(code).toBe(0);
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  await rm(directory, { recursive: true, force: true });
});

async function fixture(name: string, refuseExit = false) {
  const root = join(directory, name);
  const app = join(root, "Applications/Mochi.app/Contents/MacOS/Mochi");
  await mkdir(join(root, "Applications/Mochi.app/Contents/MacOS"), { recursive: true });
  await copyFile(executable, app);
  const manifest = join(root, "installation.json");
  await writeFile(manifest, JSON.stringify(installationManifest("0.3.0", mochiControlManifest("installed", "0.3.0"))));
  const child = Bun.spawn([app, ...(refuseExit ? ["refuse"] : [])], { stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(first.value)).toBe("ready\n");
  return { root, manifest, app, child };
}

async function stop(input: Awaited<ReturnType<typeof fixture>>, uid = String(process.getuid!())) {
  const child = Bun.spawn([
    "/bin/bash", "-c",
    'source "$1" && mochi_stop_host_application "$2" "$3" && printf committed > "$4"',
    "mochi-uninstall-exit-test", lifecycle, input.manifest, uid, join(input.root, "removal-started"),
  ], {
    env: { ...process.env, MOCHI_INSTALL_TESTING: "1", MOCHI_INSTALL_TEST_ROOT: input.root },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test("uninstall waits for the exact installed App; another Mochi build stays alive", async () => {
  const installed = await fixture("installed");
  const other = await fixture("other-build");
  const result = await stop(installed);
  expect(result.code).toBe(0);
  await installed.child.exited;
  expect(other.child.exitCode).toBeNull();
  expect(await readFile(join(installed.root, "removal-started"), "utf8")).toBe("committed");
});

test("a refused quit cannot reach removal, and the App remains available", async () => {
  const installed = await fixture("refused", true);
  const result = await stop(installed);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Nothing has been removed");
  expect(installed.child.exitCode).toBeNull();
  expect(await Bun.file(installed.app).exists()).toBe(true);
  expect(await Bun.file(join(installed.root, "removal-started")).exists()).toBe(false);
}, 20_000);

test("an executable owned by another recipient is not signalled", async () => {
  const installed = await fixture("different-owner");
  expect((await stop(installed, "1")).code).toBe(0);
  expect(installed.child.exitCode).toBeNull();
});

test("uninstaller requests confirmed App exit before stopping its supporting services", async () => {
  const script = await readFile(join(import.meta.dir, "../installer/uninstall.sh"), "utf8");
  expect(script.indexOf('mochi_stop_host_application "$INSTALLATION_MANIFEST" "$USER_ID" || exit 1'))
    .toBeLessThan(script.indexOf("/bin/launchctl bootout"));
  expect(script).not.toContain('-x Mochi');
});
