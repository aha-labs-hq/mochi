import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { installationManifest } from "../src/product/installation.ts";
import { mochiControlManifest } from "../src/control/manifest.ts";
import { installerScript } from "../controlApp/src/host/installer.ts";

const lifecycle = join(import.meta.dir, "../installer/lifecycle.sh");
test("authorization captures the App UID before the prompt and refuses invalid recipients", () => {
  const script = installerScript("/Applications/Mochi.app/Contents/Resources/Mochi-Setup.pkg", { mode: "development" }, 502);
  expect(script).toContain("development '' 502");
  expect(script).not.toContain("/dev/console");
  for (const uid of [0, 500, -1, 502.1, Number.NaN, 4294967295])
    expect(() => installerScript("/Applications/Mochi.app/Contents/Resources/Mochi-Setup.pkg", { mode: "development" }, uid)).toThrow();
});

test("only the root-authorized package context supplies the recipient, never the console or an environment default", async () => {
  const root = await mkdtemp(join(tmpdir(), "mochi-recipient-"));
  const source = (await readFile(lifecycle, "utf8"))
    .replaceAll("/usr/bin/stat", "fixture_stat")
    .replaceAll("/usr/bin/id", "fixture_id")
    .replaceAll("/usr/bin/dscl", "fixture_dscl");
  // Map just the privileged paths into this fixture; every file, symlink,
  // mode and JSON read is real, while root ownership and the user DB are simulated.
  const setup = join(root, "app.mochi.setup.AbCd1234");
  const update = join(root, "Update");
  await mkdir(setup, { mode: 0o700 });
  await mkdir(update, { mode: 0o700 });
  await writeFile(join(setup, "Mochi-Setup.pkg"), "package", { mode: 0o600 });
  await writeFile(join(setup, "recipient"), "502\n", { mode: 0o600 });
  const mapped = source.replaceAll('/private/tmp/app[.]mochi[.]setup[.]', `${root}/app[.]mochi[.]setup[.]`);
  const invoke = (pkg: string) => Bun.spawnSync(["/bin/bash", "-c", `
    fixture_stat() {
      [[ "$3" != /dev/console ]] || { echo 'console must not be read' >&2; return 1; }
      local mode; mode="$(/usr/bin/stat -f '%Lp' "$3")" || return 1
      printf '0:%s' "$mode"
    }
    fixture_id() { if [[ "$1" == -un && "$2" == 502 ]]; then echo test;
      elif [[ "$1" == -u && "$2" == test ]]; then echo 502; else return 1; fi; }
    fixture_dscl() { [[ "$3" == "/Users/test" ]] && echo "NFSHomeDirectory: /Users/test"; }
    ${mapped}
    mochi_require_bridge_user() { [[ "$2" == test ]]; }
    mochi_work_root() { printf '%s' "$ROOT"; }
    mochi_manifest_value() { if [[ "$1" == manifest ]]; then echo 0.3.2;
      else /usr/bin/plutil -extract "$2" raw -o - "$1"; fi; }
    mochi_install_recipient manifest "$1"
  `, "recipient-test", pkg], { env: { ...process.env, ROOT: root, MOCHI_INSTALL_USER_ID: "501" } });
  try {
    const pkg = join(setup, "Mochi-Setup.pkg");
    const actual = invoke(pkg);
    expect({ code: actual.exitCode, uid: actual.stdout.toString().trim(), error: actual.stderr.toString() }).toEqual({ code: 0, uid: "502", error: "" });
    await chmod(join(setup, "recipient"), 0o644);
    expect(invoke(pkg).exitCode).not.toBe(0);
    await chmod(join(setup, "recipient"), 0o600);
    await writeFile(join(setup, "recipient"), "501");
    expect(invoke(pkg).exitCode).not.toBe(0);
    await rm(join(setup, "recipient"));
    await writeFile(join(root, "forged-recipient"), "502", { mode: 0o600 });
    await symlink(join(root, "forged-recipient"), join(setup, "recipient"));
    expect(invoke(pkg).exitCode).not.toBe(0);
    expect(invoke("/Applications/Mochi.app/Contents/Resources/Mochi-Setup.pkg").exitCode).not.toBe(0);
    const request = join(update, "request.json");
    const updating = join(update, "Mochi.app/Contents/Resources/Mochi-Setup.pkg");
    await writeFile(request, JSON.stringify({ version: "0.3.2", uid: 502 }), { mode: 0o600 });
    expect(invoke(updating).stdout.toString().trim()).toBe("502");
    for (const data of [{ version: "0.3.1", uid: 502 }, { version: "0.3.2", uid: 502, mode: "uninstall" }, { version: "0.3.2", uid: 0 }]) {
      await writeFile(request, JSON.stringify(data));
      expect(invoke(updating).exitCode).not.toBe(0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("uninstall unlinks only its declared listener, and refuses an unexpected file or link", async () => {
  const root = await mkdtemp(join(tmpdir(), "mochi-sock-"));
  const path = join(root, "var/run/app.mochi.update.sock");
  await mkdir(join(root, "var/run"), { recursive: true });
  const manifest = join(root, "installation.json");
  await writeFile(manifest, JSON.stringify(installationManifest("0.3.2", mochiControlManifest("installed", "0.3.2"))));
  const run = () => Bun.spawnSync(["/bin/bash", "-c", 'source "$1" && mochi_remove_update_socket "$2"', "socket-test", lifecycle, manifest], {
    env: { ...process.env, MOCHI_INSTALL_TESTING: "1", MOCHI_INSTALL_TEST_ROOT: root },
  });
  const listener = createServer();
  try {
    expect(run().exitCode).toBe(0);
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(path, resolve); });
    expect(run().exitCode).toBe(0);
    expect(await Bun.file(path).exists()).toBe(false);
    await writeFile(path, "unexpected file");
    expect(run().exitCode).not.toBe(0);
    expect(await readFile(path, "utf8")).toBe("unexpected file");
    await rm(path);
    const target = join(root, "must-stay");
    await writeFile(target, "untouched");
    await symlink(target, path);
    expect(run().exitCode).not.toBe(0);
    expect(await readFile(target, "utf8")).toBe("untouched");
  } finally {
    listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
