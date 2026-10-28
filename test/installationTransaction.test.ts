import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mochiControlManifest } from "../src/control/manifest.ts";
import {
  installationComponentSource,
  installationManifest,
  type InstallationComponent,
  type InstallationManifest,
} from "../src/product/installation.ts";
import {
  PI_RUNTIME_CWD,
  PI_RUNTIME_USER,
  PI_SUDO_PATH,
  PI_WORKER_PATH,
} from "../src/runtime/constants.ts";
import { buildRuntimeSudoersRule } from "../src/runtime/sudoers.ts";
import { buildDurabilityTool } from "../script/build_update_helper.ts";

const repositoryRoot = join(import.meta.dir, "..");
const lifecycle = join(repositoryRoot, "installer", "lifecycle.sh");
const manifest: InstallationManifest = installationManifest("0.2.0", mochiControlManifest("installed", "0.2.0"));
// One component of each destination shape: a directory under the product root,
// a file below /usr/local, the account's LaunchAgent, and the nested record.
const shapes = ["product-bin", "host-application", "runtime-worker", "launch-agent", "update-daemon", "installation-record"]
  .map((id) => manifest.transactionalComponents.find((entry) => entry.id === id)!);
const shapeManifest: InstallationManifest = {
  ...manifest,
  transactionalComponentCount: shapes.length,
  transactionalComponents: shapes,
};
const createdMark = "app.mochi.installer.created";
const consoleHome = "/Users/test";
const fixtureRoots: string[] = [];
let durabilityTool: string;
beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), "mochi-durability-tool-"));
  fixtureRoots.push(directory);
  durabilityTool = join(directory, "mochi-file-sync");
  await buildDurabilityTool(durabilityTool);
});

afterAll(async () => {
  for (const path of fixtureRoots) {
    await run(["/bin/chmod", "-R", "u+rwx", path]);
    await rm(path, { recursive: true, force: true });
  }
});

interface Fixture {
  contract: InstallationManifest;
  root: string;
  manifestPath: string;
  tracePath: string;
}

interface Result {
  code: number;
  stderr: string;
  stdout: string;
}

/**
 * A fixture root holds what a clean Mac already has above Mochi's components,
 * plus Mochi's staged payload; `/usr/local` and every Mochi directory are absent.
 */
async function fixture(withExisting: boolean, contract = manifest): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "mochi-install-transaction-"));
  fixtureRoots.push(directory);
  const root = join(directory, "root");
  for (const path of ["Library/Application Support", "usr", "etc/sudoers.d", "Users/test/Library/LaunchAgents"]) {
    await mkdir(join(root, path), { recursive: true, mode: 0o755 });
  }
  const manifestPath = join(directory, "installation.json");
  const tracePath = join(directory, "boundaries.txt");
  await writeFile(manifestPath, `${JSON.stringify(contract)}\n`);
  for (const component of contract.transactionalComponents) {
    await writeComponent(prefixed(root, installationComponentSource(contract, component)), component, "new");
    if (withExisting) await writeComponent(destination(root, component), component, "old");
  }
  return { contract, root, manifestPath, tracePath };
}

function prefixed(root: string, absolutePath: string): string {
  return join(root, absolutePath.slice(1));
}

function destination(root: string, component: InstallationComponent): string {
  const absolute = component.destinationScope === "system"
    ? component.destination
    : component.destinationScope === "consoleUserHome"
      ? `${consoleHome}/${component.destination}`
      : `/Users/_mochi/${component.destination === "." ? "" : component.destination}`;
  return prefixed(root, absolute);
}

async function writeComponent(
  path: string,
  component: InstallationComponent,
  version: "old" | "new",
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (component.kind === "directory") {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "fixture-version"), `${version}:${component.id}\n`);
  } else {
    await writeFile(path, `${version}:${component.id}\n`);
  }
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<Result> {
  const child = Bun.spawn({ cmd, cwd: repositoryRoot, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function fixtureEnvironment(input: Fixture, home = consoleHome): Record<string, string> {
  return {
    MOCHI_INSTALL_TESTING: "1",
    MOCHI_INSTALL_TEST_ROOT: input.root,
    MOCHI_INSTALL_TEST_DURABILITY_TOOL: durabilityTool,
    MOCHI_CONSOLE_USER_HOME: home,
    MOCHI_RUNTIME_HOME: "/Users/_mochi",
  };
}

/** Runs one lifecycle action under the package scripts' umask 077. */
function lifecycleAction(
  input: Fixture,
  action: string,
  options: { interruptAfter?: number; trace?: boolean; home?: string } = {},
): Promise<Result> {
  return run(["/bin/bash", "-c", 'umask 077; exec /bin/bash "$0" "$@"', lifecycle, action, input.manifestPath], {
    ...fixtureEnvironment(input, options.home),
    ...(options.interruptAfter === undefined ? {} : { MOCHI_INSTALL_TEST_INTERRUPT_AFTER: String(options.interruptAfter) }),
    ...(options.trace ? { MOCHI_INSTALL_TEST_TRACE_FILE: input.tracePath } : {}),
  });
}

/** Calls one lifecycle function directly, the way the package scripts source it. */
function lifecycleFunction(input: Fixture, ...args: string[]): Promise<Result> {
  return run(
    ["/bin/bash", "-c", 'lifecycle="$1"; shift; source "$lifecycle" && "$@"', "mochi-lifecycle-test", lifecycle, ...args],
    fixtureEnvironment(input),
  );
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function componentVersion(path: string, component: InstallationComponent): Promise<string> {
  return readFile(component.kind === "directory" ? join(path, "fixture-version") : path, "utf8");
}

async function expectInstalled(input: Fixture, boundary?: number): Promise<void> {
  for (const component of input.contract.transactionalComponents) {
    expect(await componentVersion(destination(input.root, component), component)).toBe(`new:${component.id}\n`);
  }
  for (const path of [manifest.payloadRoot, manifest.transactionRoot]) {
    if (await exists(prefixed(input.root, path))) {
      throw new Error(`${path} remains after replay${boundary ? ` at boundary ${boundary}` : ""}`);
    }
  }
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

async function marked(path: string): Promise<boolean> {
  return (await run(["/usr/bin/xattr", "-p", createdMark, path])).code === 0;
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

describe("native package component transaction", () => {
  test("preparation retains the running App inode through commit and rollback", async () => {
    const input = await fixture(true, shapeManifest);
    const app = input.contract.transactionalComponents.find((c) => c.id === "host-application")!;
    const installed = destination(input.root, app);
    await writeComponent(installed, app, "new");
    const original = await stat(installed);
    const committed = await lifecycleFunction(input, "mochi_commit_transaction", input.manifestPath, "retain-application");
    expect(committed.code).toBe(0);
    expect((await stat(installed)).ino).toBe(original.ino);
    const recovered = await lifecycleFunction(input, "mochi_recover_transaction", input.manifestPath);
    expect(recovered.code).toBe(0);
    expect((await stat(installed)).ino).toBe(original.ino);
    expect(await componentVersion(installed, app)).toBe("new:host-application\n");
    for (const component of input.contract.transactionalComponents.filter((c) => c !== app))
      expect(await componentVersion(destination(input.root, component), component)).toBe(`old:${component.id}\n`);
  }, 30_000);

  test("preparation refuses a changed host App before committing any component", async () => {
    const input = await fixture(true, shapeManifest);
    const committed = await lifecycleFunction(input, "mochi_commit_transaction", input.manifestPath, "retain-application");
    expect(committed.code).toBe(1);
    expect(committed.stderr).toContain("application that changed");
    expect(await exists(prefixed(input.root, input.contract.transactionRoot))).toBe(false);
    for (const component of input.contract.transactionalComponents)
      expect(await componentVersion(destination(input.root, component), component)).toBe(`old:${component.id}\n`);
  });

  test("the same contract at two paths permits repair and detects cleanup drift", async () => {
    const input = await fixture(false);
    const installed = join(input.root, "installed.json");
    await writeFile(installed, JSON.stringify(input.contract));
    const matching = await lifecycleFunction(input, "mochi_contract_structure_matches", input.manifestPath, installed);
    expect(matching.code).toBe(0);
    expect(matching.stdout + matching.stderr).toBe("");
    const changed = {
      ...input.contract,
      retainedRoots: input.contract.retainedRoots.map((root, index) => index === 0
        ? { ...root, cleanup: ["unexpected-cleanup"] } : root),
    };
    await writeFile(installed, JSON.stringify(changed));
    const drifted = await lifecycleFunction(input, "mochi_contract_structure_matches", input.manifestPath, installed);
    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toContain("cleanup contract drifted");
  }, 30_000);

  test("retention coverage may append roots without changing any existing ownership", async () => {
    const input = await fixture(false);
    const installed = join(input.root, "installed.json");
    const previous = { ...input.contract, retainedRoots: input.contract.retainedRoots.slice(0, -3),
      retainedRootCount: input.contract.retainedRootCount - 3 };
    await writeFile(installed, JSON.stringify(previous));
    expect((await lifecycleFunction(input, "mochi_contract_structure_matches", input.manifestPath, installed)).code).toBe(0);
    const drifted = { ...previous, retainedRoots: previous.retainedRoots.map((root, index) => index === 0
      ? { ...root, path: "Library/Unrelated" } : root) };
    await writeFile(installed, JSON.stringify(drifted));
    expect((await lifecycleFunction(input, "mochi_contract_structure_matches", input.manifestPath, installed)).code).toBe(1);
  }, 30_000);

  test("root cleanup refuses a redirected parent and only unlinks a final symlink", async () => {
    const input = await fixture(false);
    const owned = join(input.root, "owned"), unrelated = join(input.root, "unrelated");
    await mkdir(owned); await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "preserve");
    await symlink(unrelated, join(owned, "redirect"));
    expect((await lifecycleFunction(input, "mochi_remove_owned_path", join(owned, "redirect/keep"))).code).toBe(1);
    expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("preserve");
    expect((await lifecycleFunction(input, "mochi_remove_owned_path", join(owned, "redirect"))).code).toBe(0);
    expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("preserve");
  });

  test("root cleanup proves the directory it entered, not the path bash remembers", async () => {
    const input = await fixture(false);
    const owned = join(input.root, "owned"), unrelated = join(input.root, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "preserve");
    await symlink(unrelated, owned);
    // The account puts a real directory back the instant root has followed its link.
    const raced = await run(["/bin/bash", "-c", `
source "$1"
owned="$2"
cd() { builtin cd "$@" && /bin/rm "$owned" && /bin/mkdir "$owned"; }
mochi_remove_owned_path "$owned/keep"
`, "mochi-race-test", lifecycle, owned], fixtureEnvironment(input));
    expect(raced.code).not.toBe(0);
    expect(raced.stderr).toContain("redirected directory");
    expect(await readFile(join(unrelated, "keep"), "utf8")).toBe("preserve");
  });

  test("failed plutil extraction cannot return a diagnostic as a manifest value", async () => {
    const source = await readFile(lifecycle, "utf8");
    const start = source.indexOf("mochi_manifest_value() {");
    const end = source.indexOf("\n}\n", start) + 3;
    const helper = source.slice(start, end).replaceAll("/usr/bin/plutil", "fixture_plutil");
    const result = await run(["/bin/bash", "-c", `MOCHI_CONTRACT=''
fixture_plutil() { printf '%s: Could not extract value\\n' "$6"; return 1; }
${helper}
mochi_manifest_value /private/installation.json missing.key`]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("a clean Mac gets every missing ancestor as a searchable, marked directory", async () => {
    const clean = await fixture(false);
    // A directory that already exists keeps exactly the mode it had.
    await chmod(join(clean.root, "Library/Application Support"), 0o755);
    const result = await lifecycleAction(clean, "apply");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    await expectInstalled(clean);
    expect(await exists(prefixed(clean.root, manifest.workRoot))).toBeFalse();

    for (const path of [
      "Library/Application Support/Mochi",
      "Library/Application Support/Mochi/Installation",
      "usr/local",
      "usr/local/libexec",
      "usr/local/share",
      "usr/local/share/doc",
    ]) {
      expect({ path, mode: await mode(join(clean.root, path)) }).toEqual({ path, mode: 0o755 });
      expect({ path, marked: await marked(join(clean.root, path)) }).toEqual({ path, marked: true });
    }
    for (const path of ["Library/Application Support", "usr", "etc/sudoers.d"]) {
      expect({ path, marked: await marked(join(clean.root, path)) }).toEqual({ path, marked: false });
    }
    expect(await mode(join(clean.root, "Library/Application Support"))).toBe(0o755);
  }, 30_000);

  test("ordinary group write access fails before directory creation or component movement", async () => {
    const blocked = await fixture(false);
    const ancestor = join(blocked.root, "Library/Application Support");
    expect((await run(["/usr/bin/chgrp", "staff", ancestor])).code).toBe(0);
    await chmod(ancestor, 0o775);
    const result = await lifecycleAction(blocked, "apply");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ordinary group write access");
    expect(await exists(join(ancestor, "Mochi"))).toBeFalse();
    expect(await mode(ancestor)).toBe(0o775);
  }, 30_000);

  test("write ACLs fail before moving existing components and remain untouched", async () => {
    const blocked = await fixture(true);
    const ancestor = join(blocked.root, "usr/local/libexec");
    expect((await run(["/bin/chmod", "+a", "everyone allow add_file,delete_child", ancestor])).code).toBe(0);
    const result = await lifecycleAction(blocked, "apply");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("additional write ACL");
    expect((await run(["/bin/ls", "-lde", ancestor])).stdout).toContain("allow add_file,delete_child");
    expect(await exists(prefixed(blocked.root, manifest.transactionRoot))).toBeFalse();
    for (const component of manifest.transactionalComponents) {
      expect(await componentVersion(destination(blocked.root, component), component)).toBe(`old:${component.id}\n`);
    }
  }, 30_000);

  test("ancestor trust rejects an ordinary owner even with mode 755", async () => {
    const input = await fixture(true);
    const source = await readFile(lifecycle, "utf8");
    const start = source.indexOf("mochi_verify_reachable_ancestors() {");
    const end = source.indexOf("\n}\n", start) + 3;
    const helper = source.slice(start, end)
      .replaceAll("/usr/bin/stat", "fixture_stat")
      .replaceAll("/usr/bin/id", "fixture_id");
    const result = await run(["/bin/bash", "-c", `
MOCHI_INSTALL_TESTING=0
fixture_stat() { case "$*" in *'%u %g'*) printf '50002 20 0755\\n';; *) printf '0755\\n';; esac; }
fixture_id() { printf '20 12\\n'; }
mochi_parent() { /usr/bin/dirname "$1"; }
mochi_system_path() { printf '%s%s\\n' "$MOCHI_FIXTURE_ROOT" "$1"; }
${helper}
mochi_verify_reachable_ancestors /usr/local/libexec/worker
`], { MOCHI_FIXTURE_ROOT: input.root });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("owned by an ordinary account");
  });

  test("ancestor trust rejects redirected directories before creating children", async () => {
    const input = await fixture(false);
    const other = join(input.root, "redirected");
    await mkdir(other);
    await symlink(other, join(input.root, "usr/local"));
    const result = await lifecycleAction(input, "apply");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("redirected system directory");
    expect(await readdir(other)).toEqual([]);
  }, 30_000);

  test("an ancestor other accounts cannot search fails before any component moves", async () => {
    const blocked = await fixture(true);
    await chmod(join(blocked.root, "usr/local/share"), 0o700);
    const result = await lifecycleAction(blocked, "apply");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("/usr/local/share has mode 0700");
    expect(await exists(prefixed(blocked.root, manifest.transactionRoot))).toBeFalse();
    for (const component of manifest.transactionalComponents) {
      expect(await componentVersion(destination(blocked.root, component), component)).toBe(`old:${component.id}\n`);
    }
    expect(await mode(join(blocked.root, "usr/local/share"))).toBe(0o700);
  }, 30_000);

  test("fresh install and same-version repair converge idempotently", async () => {
    const fresh = await fixture(false);
    expect((await lifecycleAction(fresh, "apply")).code).toBe(0);
    await expectInstalled(fresh);
    expect((await lifecycleAction(fresh, "apply")).code).toBe(0);
    await expectInstalled(fresh);

    const repair = await fixture(true);
    expect((await lifecycleAction(repair, "apply")).code).toBe(0);
    await expectInstalled(repair);
  }, 30_000);

  test("hard interruption at every recorded mutation boundary replays to one version", async () => {
    // A clean Mac and an upgrade record different boundaries; both replay from each.
    const pending: (readonly [number, boolean])[] = [];
    for (const withExisting of [false, true]) {
      const traced = await fixture(withExisting, shapeManifest);
      expect((await lifecycleAction(traced, "apply", { trace: true })).code).toBe(0);
      const boundaries = (await readFile(traced.tracePath, "utf8")).trim().split("\n");
      expect(boundaries.length).toBeGreaterThan(shapeManifest.transactionalComponentCount * 2);
      expect(boundaries.some((line) => line.includes("create-directory:"))).toBe(!withExisting);
      boundaries.forEach((_, index) => pending.push([index + 1, withExisting]));
    }

    // Each boundary has its own fixture, so the replays run side by side.
    const replay = async (boundary: number, withExisting: boolean) => {
      const interrupted = await fixture(withExisting, shapeManifest);
      const killed = await lifecycleAction(interrupted, "apply", { interruptAfter: boundary });
      if (killed.code === 0) throw new Error(`boundary ${boundary} was never reached`);
      const replayed = await lifecycleAction(interrupted, "apply");
      if (replayed.code !== 0) throw new Error(`replay after boundary ${boundary} failed: ${replayed.stderr}`);
      await expectInstalled(interrupted, boundary);
    };
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let next = pending.shift(); next; next = pending.shift()) await replay(...next);
    }));
  }, 120_000);

  test("failed health restores the App and every backend component to the same predecessor", async () => {
    const input = await fixture(true);
    const committed = await lifecycleFunction(input, "mochi_commit_transaction", input.manifestPath);
    expect(committed.code).toBe(0);
    const recovered = await lifecycleAction(input, "recover");
    expect(recovered.code).toBe(0);
    for (const component of input.contract.transactionalComponents)
      expect(await componentVersion(destination(input.root, component), component)).toBe(`old:${component.id}\n`);
  }, 30_000);

  test("a finalized journal whose components are gone fails closed and keeps the journal", async () => {
    const broken = await fixture(false);
    const transaction = prefixed(broken.root, manifest.transactionRoot);
    await mkdir(transaction, { recursive: true });
    await writeFile(join(transaction, "account-home"), `${consoleHome}\n`);
    await writeFile(join(transaction, "finalized"), "0.2.0\n");

    const result = await lifecycleAction(broken, "recover");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no longer verify");
    expect(await exists(join(transaction, "finalized"))).toBeTrue();
    expect(await exists(prefixed(broken.root, manifest.payloadRoot))).toBeTrue();
  }, 30_000);

  test("interruption inside finalized journal deletion can never restore the predecessor", async () => {
    const input = await fixture(true, shapeManifest);
    expect((await lifecycleAction(input, "commit")).code).toBe(0);
    const transaction = prefixed(input.root, manifest.transactionRoot);
    // rm is not atomic: its finalized marker can disappear before the backups.
    // Interrupt inside the deletion, not just at the recorded boundary after it.
    const interrupted = await run(["/bin/bash", "-c", `
source "$1"
transaction_prefix="$3"
mochi_remove_tree() {
  case "$1" in
    "$transaction_prefix"*) /bin/rm -f "$1/finalized"; return 1 ;;
    *) /bin/rm -rf "$1" ;;
  esac
}
mochi_finalize_transaction "$2"
`, "mochi-cleanup-test", lifecycle, input.manifestPath, transaction], fixtureEnvironment(input));
    expect(interrupted.code).not.toBe(0);
    expect((await lifecycleAction(input, "recover")).code).toBe(0);
    for (const component of input.contract.transactionalComponents)
      expect(await componentVersion(destination(input.root, component), component)).toBe(`new:${component.id}\n`);
  }, 30_000);

  test("a restore step that fails keeps the journal and backup and never nests a component", async () => {
    const stuck = await fixture(true, shapeManifest);
    const bin = shapeManifest.transactionalComponents[0]!;
    expect(bin.id).toBe("product-bin");
    // Interrupt right after the first component is installed.
    const traced = await fixture(true, shapeManifest);
    await lifecycleAction(traced, "apply", { trace: true });
    const lines = (await readFile(traced.tracePath, "utf8")).trim().split("\n");
    const installed = lines.findIndex((line) => line.endsWith(" install:0")) + 1;
    expect(installed).toBeGreaterThan(0);
    expect((await lifecycleAction(stuck, "apply", { interruptAfter: installed })).code).not.toBe(0);

    // The package delivers its payload again, and the new component cannot be removed.
    await writeComponent(prefixed(stuck.root, installationComponentSource(shapeManifest, bin)), bin, "new");
    const locked = join(destination(stuck.root, bin), "locked");
    await mkdir(locked);
    await writeFile(join(locked, "file"), "x");
    await chmod(locked, 0o500);

    const result = await lifecycleAction(stuck, "recover");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not remove");
    const backup = join(prefixed(stuck.root, manifest.transactionRoot), "entries/0/original");
    expect(await componentVersion(backup, bin)).toBe("old:product-bin\n");
    expect(await exists(join(destination(stuck.root, bin), "original"))).toBeFalse();

    await chmod(locked, 0o700);
    const retried = await lifecycleAction(stuck, "recover");
    expect(retried.code).toBe(0);
    expect(await componentVersion(destination(stuck.root, bin), bin)).toBe("old:product-bin\n");
    expect(await exists(prefixed(stuck.root, manifest.transactionRoot))).toBeFalse();
  }, 30_000);

  test("a durability failure before the write-ahead mark leaves every predecessor recoverable", async () => {
    const input = await fixture(true, shapeManifest);
    const failed = await run(["/bin/bash", "-c", `
source "$1"
mochi_sync() {
  case "$2" in */started.tmp.*) return 1 ;; esac
  "$MOCHI_INSTALL_TEST_DURABILITY_TOOL" "$@"
}
mochi_commit_transaction "$2"
`, "mochi-flush-failure", lifecycle, input.manifestPath], fixtureEnvironment(input));
    expect(failed.code).not.toBe(0);
    for (const component of input.contract.transactionalComponents)
      expect(await componentVersion(destination(input.root, component), component)).toBe(`old:${component.id}\n`);
    expect((await lifecycleAction(input, "recover")).code).toBe(0);
    expect((await lifecycleAction(input, "apply")).code).toBe(0);
    await expectInstalled(input);
  }, 30_000);

  test("conflicting or symlinked retired journals preserve the installed set and evidence", async () => {
    const input = await fixture(true, shapeManifest);
    expect((await lifecycleAction(input, "commit")).code).toBe(0);
    const transaction = prefixed(input.root, manifest.transactionRoot);
    await mkdir(`${transaction}.finalized`);
    const conflict = await lifecycleAction(input, "recover");
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain("conflicting journals");
    expect(await exists(join(transaction, "entries/0/original"))).toBeTrue();
    await rm(`${transaction}.finalized`, { recursive: true });
    await symlink(join(input.root, "missing"), `${transaction}.restored`);
    expect((await lifecycleAction(input, "recover")).code).not.toBe(0);
    expect((await lstat(`${transaction}.restored`)).isSymbolicLink()).toBeTrue();
    for (const component of input.contract.transactionalComponents)
      expect(await componentVersion(destination(input.root, component), component)).toBe(`new:${component.id}\n`);
  }, 30_000);

  test("a journal replays only for the account whose paths it recorded", async () => {
    const interrupted = await fixture(true, shapeManifest);
    const traced = await fixture(true, shapeManifest);
    await lifecycleAction(traced, "apply", { trace: true });
    const lines = (await readFile(traced.tracePath, "utf8")).trim().split("\n");
    const lastInstall = lines.findLastIndex((line) => / install:\d+$/.test(line)) + 1;
    expect((await lifecycleAction(interrupted, "apply", { interruptAfter: lastInstall })).code).not.toBe(0);

    const other = await lifecycleAction(interrupted, "recover", { home: "/Users/bridge" });
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain("belongs to another macOS account");
    expect(await exists(prefixed(interrupted.root, manifest.transactionRoot))).toBeTrue();

    expect((await lifecycleAction(interrupted, "apply")).code).toBe(0);
    await expectInstalled(interrupted);
  }, 30_000);

  test("an account that links its LaunchAgents elsewhere mid-transaction never redirects root", async () => {
    const agent = shapeManifest.transactionalComponents.find((c) => c.id === "launch-agent")!;
    const index = shapeManifest.transactionalComponents.indexOf(agent);
    // The account swaps its directory for a link to one only root may change.
    const redirect = async (input: Fixture) => {
      const agents = dirname(destination(input.root, agent));
      const daemons = join(input.root, "Library/LaunchDaemons");
      const bystander = join(daemons, "app.mochi.bridge.plist");
      await mkdir(daemons, { recursive: true });
      await writeFile(bystander, "root's own\n");
      return { agents, daemons, bystander };
    };
    const restore = async (agents: string) => {
      await rm(agents);
      await rename(`${agents}.real`, agents);
    };

    // Commit: the link appears after the parent check, once the journal has begun.
    const committing = await fixture(true, shapeManifest);
    const commit = await redirect(committing);
    const swapped = await run(["/bin/bash", "-c", `
source "$1"
agents="$3" daemons="$4"
mochi_boundary() {
  [[ "$1" != begin:* ]] || { /bin/mv "$agents" "$agents.real" && /bin/ln -s "$daemons" "$agents"; }
}
mochi_commit_transaction "$2"
`, "mochi-swap-test", lifecycle, committing.manifestPath, commit.agents, commit.daemons], fixtureEnvironment(committing));
    expect(await readFile(commit.bystander, "utf8")).toBe("root's own\n");
    expect(swapped.code).not.toBe(0);
    expect(swapped.stderr).toContain("redirected directory");
    await restore(commit.agents);
    expect((await lifecycleAction(committing, "recover")).code).toBe(0);
    for (const component of shapeManifest.transactionalComponents)
      expect(await componentVersion(destination(committing.root, component), component)).toBe(`old:${component.id}\n`);

    // Rollback: the link appears after the new plist is in place.
    const traced = await fixture(true, shapeManifest);
    expect((await lifecycleAction(traced, "apply", { trace: true })).code).toBe(0);
    const lines = (await readFile(traced.tracePath, "utf8")).trim().split("\n");
    const installed = lines.findIndex((line) => line.endsWith(` install:${index}`)) + 1;
    expect(installed).toBeGreaterThan(0);
    const rollingBack = await fixture(true, shapeManifest);
    expect((await lifecycleAction(rollingBack, "apply", { interruptAfter: installed })).code).not.toBe(0);
    const rollback = await redirect(rollingBack);
    await rename(rollback.agents, `${rollback.agents}.real`);
    await symlink(rollback.daemons, rollback.agents);
    const refused = await lifecycleAction(rollingBack, "recover");
    expect(await readFile(rollback.bystander, "utf8")).toBe("root's own\n");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("redirected directory");
    expect(await exists(join(prefixed(rollingBack.root, manifest.transactionRoot), `entries/${index}/original`))).toBeTrue();
    await restore(rollback.agents);
    expect((await lifecycleAction(rollingBack, "recover")).code).toBe(0);
    for (const component of shapeManifest.transactionalComponents)
      expect(await componentVersion(destination(rollingBack.root, component), component)).toBe(`old:${component.id}\n`);
  }, 30_000);

  test("uninstall removes only the empty directories the installer created", async () => {
    const installed = await fixture(false);
    await mkdir(join(installed.root, "usr/local"), { mode: 0o755 });
    expect((await lifecycleAction(installed, "apply")).code).toBe(0);
    for (const component of manifest.transactionalComponents) {
      await rm(destination(installed.root, component), { recursive: true });
    }
    // Something else now uses one directory Mochi created.
    await writeFile(join(installed.root, "usr/local/share/foreign"), "kept");

    const result = await lifecycleAction(installed, "remove-created-directories");
    expect(result.code).toBe(0);
    for (const path of ["usr/local/libexec", "usr/local/share/doc", "Library/Application Support/Mochi"]) {
      expect({ path, exists: await exists(join(installed.root, path)) }).toEqual({ path, exists: false });
    }
    for (const path of ["usr/local", "usr/local/share", "etc/sudoers.d", "Library/Application Support"]) {
      expect({ path, exists: await exists(join(installed.root, path)) }).toEqual({ path, exists: true });
    }
  }, 30_000);
});

describe("installer lifecycle policy helpers", () => {
  test("renders the runtime sudoers rule that the Bridge policy owns", async () => {
    const input = await fixture(false);
    const worker = prefixed(input.root, installationComponentSource(
      manifest,
      manifest.transactionalComponents.find((entry) => entry.id === "runtime-worker")!,
    ));
    const runtime = { sudoPath: PI_SUDO_PATH, runtimeUser: PI_RUNTIME_USER, workerPath: PI_WORKER_PATH, runtimeCwd: PI_RUNTIME_CWD };
    const digest = await sha256(worker);
    const rendered = await lifecycleFunction(input, "mochi_render_runtime_sudoers", input.manifestPath, "bridge-user", worker);
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).toBe(buildRuntimeSudoersRule("bridge-user", runtime, digest));
    // Managed Macs commonly name accounts first.last; short names may carry capitals.
    for (const account of ["first.last", "Bridge.User"]) {
      expect(await lifecycleFunction(input, "mochi_render_runtime_sudoers", input.manifestPath, account, worker))
        .toEqual({ code: 0, stdout: buildRuntimeSudoersRule(account, runtime, digest), stderr: "" });
    }
    for (const account of ["root", "BRIDGE", "bridge user", "2fa"]) {
      expect((await lifecycleFunction(input, "mochi_render_runtime_sudoers", input.manifestPath, account, worker)).code)
        .not.toBe(0);
    }

    const installedRule = destination(input.root, manifest.transactionalComponents.find((entry) => entry.id === "runtime-sudoers")!);
    expect((await lifecycleFunction(input, "mochi_installed_bridge_user", input.manifestPath)).stdout).toBe("");
    await writeFile(installedRule, rendered.stdout);
    expect((await lifecycleFunction(input, "mochi_installed_bridge_user", input.manifestPath)).stdout).toBe("bridge-user\n");
    await writeFile(installedRule, buildRuntimeSudoersRule("first.last", runtime, digest));
    expect((await lifecycleFunction(input, "mochi_installed_bridge_user", input.manifestPath)).stdout).toBe("first.last\n");
  });

  test("adopts the shared parent only from root or the Bridge account, never through a link", async () => {
    const input = await fixture(false);
    // Bun's userInfo().username uses environment hints that verification strips.
    // Read the OS account, as the installer's ownership proof does.
    const identity = await run(["/usr/bin/id", "-un"]);
    expect(identity.code).toBe(0);
    const me = identity.stdout.trim();
    await mkdir(join(input.root, "Users/Shared"), { recursive: true });
    const shared = join(input.root, "Users/Shared/mochi");

    expect(await lifecycleFunction(input, "mochi_adopt_shared_directory", "/Users/Shared/mochi", me))
      .toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await mode(shared)).toBe(0o700);
    expect((await lstat(shared)).uid).toBe(process.getuid!());
    expect((await lifecycleFunction(input, "mochi_adopt_shared_directory", "/Users/Shared/mochi", me)).code).toBe(0);

    const squatted = await lifecycleFunction(input, "mochi_adopt_shared_directory", "/Users/Shared/mochi", "nobody");
    expect(squatted.code).not.toBe(0);
    expect(squatted.stderr).toContain(`belongs to the macOS account ${me}`);

    await rm(shared, { recursive: true });
    await symlink(join(input.root, "etc"), shared);
    const linked = await lifecycleFunction(input, "mochi_adopt_shared_directory", "/Users/Shared/mochi", me);
    expect(linked.code).not.toBe(0);
    expect(linked.stderr).toContain("requires a real directory");
    expect((await readdir(join(input.root, "etc"))).sort()).toEqual(["sudoers.d"]);
  });
});
