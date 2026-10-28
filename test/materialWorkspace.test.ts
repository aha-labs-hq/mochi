import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../src/attachments/artifacts.ts";
import {
  MaterialWorkspace,
  materialParentTraverseAcl,
  materialRootReadAcl,
  prepareMaterialRoot,
  resetMaterialWorkspaces,
  verifyMaterialRoot,
} from "../src/attachments/materialWorkspace.ts";

// Every Mac has `nobody`; tests never depend on the provisioned runtime account.
const runtimeUser = "nobody";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("turn material workspace", () => {
  test("publishes only immutable inputs and erases the turn", () => {
    const directory = temporaryDirectory();
    const root = join(directory, "materials");
    const staging = join(directory, "staging");
    mkdirSync(root);
    const artifacts = new AttachmentStore(staging).createMessageArtifacts();
    const artifact = artifacts.addAttachment({
      bytes: new TextEncoder().encode("hello"),
      fileName: "notes.txt",
      kind: "file",
      mimeType: "text/plain; charset=utf-8",
    });
    const workspace = new MaterialWorkspace(root);
    const turnDirectory = workspace.cwd;
    try {
      const material = workspace.publish(artifacts).get(artifact.id);
      const evidencePath = workspace.publishTopicEvidence({
        version: 2,
        referencedMessageIds: [],
        delivery: "handled",
        chatId: "oc_group",
        threadKey: "omt_topic",
        limitations: [],
        messages: [],
      });
      expect(material?.localPath).toStartWith(`${turnDirectory}/input/message-1/`);
      expect(readFileSync(material?.localPath ?? "", "utf8")).toBe("hello");
      expect(statSync(material?.localPath ?? "").mode & 0o777).toBe(0o400);
      expect(evidencePath).toBe(`${turnDirectory}/input/topic-evidence-01.json`);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        version: 2,
        threadKey: "omt_topic",
      });
      expect(statSync(evidencePath).mode & 0o777).toBe(0o400);
      expect(readdirSync(turnDirectory)).toEqual(["input"]);
    } finally {
      artifacts.dispose();
      workspace.dispose();
    }
    expect(existsSync(turnDirectory)).toBeFalse();
  });

  test("refuses unexpected shared-root entries", () => {
    const directory = temporaryDirectory();
    const root = join(directory, "materials");
    mkdirSync(root);
    expect(() => resetMaterialWorkspaces(root, runtimeUser)).not.toThrow();
    writeFileSync(join(root, "keep"), "unexpected");
    expect(() => resetMaterialWorkspaces(root, runtimeUser)).toThrow("Unexpected entry");
  });

  test("uses narrow inherited macOS ACL contracts", () => {
    expect(materialParentTraverseAcl("_mochi")).toBe(
      "user:_mochi allow search",
    );
    expect(materialRootReadAcl("_mochi")).toBe(
      "user:_mochi allow list,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
    );
  });

  test("replaces whatever another account left with the exact access policy", () => {
    const parent = temporaryDirectory();
    const root = join(parent, "materials");
    mkdirSync(root, { mode: 0o755 });
    // A squatter's inheritable grant and a broad entry, as planted before setup.
    for (const entry of [
      "user:nobody allow add_file,add_subdirectory,delete_child,file_inherit,directory_inherit",
      "everyone allow list,search,file_inherit,directory_inherit",
    ]) {
      expect(spawnSync("/bin/chmod", ["+a", entry, root]).status).toBe(0);
    }
    chmodSync(parent, 0o755);

    prepareMaterialRoot(root, runtimeUser);

    expect(accessControl(parent)).toEqual({ mode: 0o700, entries: [materialParentTraverseAcl(runtimeUser)] });
    expect(accessControl(root)).toEqual({ mode: 0o700, entries: [materialRootReadAcl(runtimeUser)] });
    const workspace = new MaterialWorkspace(root);
    try {
      expect(spawnSync("/bin/ls", ["-lde", workspace.cwd], { encoding: "utf8" }).stdout)
        .toContain(`user:${runtimeUser} inherited allow list,search`);
    } finally {
      workspace.dispose();
    }
  });

  test("verification fails closed on any drift in mode, ACL, or path shape", () => {
    const parent = temporaryDirectory();
    const root = join(parent, "materials");
    prepareMaterialRoot(root, runtimeUser);
    expect(() => verifyMaterialRoot(root, runtimeUser)).not.toThrow();

    chmodSync(root, 0o750);
    expect(() => verifyMaterialRoot(root, runtimeUser)).toThrow("must be mode 700");
    chmodSync(root, 0o700);

    expect(spawnSync("/bin/chmod", ["+a", "everyone allow list", parent]).status).toBe(0);
    expect(() => verifyMaterialRoot(root, runtimeUser)).toThrow("exactly one ACL entry");
    prepareMaterialRoot(root, runtimeUser);

    const elsewhere = temporaryDirectory();
    rmSync(root, { recursive: true });
    symlinkSync(elsewhere, root);
    expect(() => prepareMaterialRoot(root, runtimeUser)).toThrow("must be a real directory");
    expect(() => verifyMaterialRoot(root, runtimeUser)).toThrow("must be a real directory");
  });
});

function accessControl(path: string): { mode: number; entries: string[] } {
  const listing = spawnSync("/bin/ls", ["-lde", path], { encoding: "utf8" }).stdout;
  return {
    mode: statSync(path).mode & 0o7777,
    entries: listing.split("\n").slice(1).flatMap((line) => /^\s*\d+: (.+)$/.exec(line)?.[1] ?? []),
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mochi-materials-"));
  directories.push(directory);
  return directory;
}
