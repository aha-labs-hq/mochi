import { describe, expect, test } from "bun:test";
import { AGENT_TOOLS } from "../src/agent/tools.ts";
import { CONNECTOR_TOOLS } from "../src/agent/connectorTools.ts";
import {
  GITHUB_CAPABILITIES,
  capabilityIdFor,
  toolNameFor,
} from "../src/connectors/github/manifest.ts";
import { ISSUE_ACTION_TOOL, READ_ONLY_TOOLS } from "../src/connectors/github/operations.ts";
import { runtimeLauncherEnvironment, runtimeWorkerCommand } from "../src/runtime/process.ts";
import { isFixedPiMaterialRoot, PI_MATERIAL_ROOT } from "../src/runtime/constants.ts";
import { buildRuntimeSudoersRule } from "../src/runtime/sudoers.ts";
import type { RuntimeConfig } from "../src/config.ts";
import {
  buildCreateReactionCommand,
  buildDeleteReactionCommand,
  buildReplyCommand,
  sanitizeMarkdown,
} from "../src/lark/messenger.ts";
import { larkEnvironment } from "../src/lark/process.ts";

describe("capability boundary", () => {
  test("exposes one provider-neutral surface and no per-provider tool", () => {
    // The ABI is the four connector tools and nothing else: a provider's
    // operations are data in its manifest, so adding one never changes the tools
    // a permanent Session was bound to.
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual([
      "connector_catalog", "connector_describe", "connector_read", "connector_write",
    ]);
    expect(AGENT_TOOLS).toHaveLength(CONNECTOR_TOOLS.length);
    for (const tool of AGENT_TOOLS) {
      // No tool may accept a provider address or a repository selector: the
      // capability boundary is the Broker's, reached only by catalog identity.
      for (const forbidden of ["repository_id", "url", "path", "endpoint", "method"]) {
        expect(Object.keys(tool.inputSchema.properties)).not.toContain(forbidden);
        expect(tool.inputSchema.required).not.toContain(forbidden);
      }
    }
  });

  test("declares GitHub's operations as capabilities, not as tools", () => {
    // Every read and the one write reach the model through the catalog, so the
    // manifest and the ABI cannot drift apart.
    expect(GITHUB_CAPABILITIES).toHaveLength(READ_ONLY_TOOLS.length + 1);
    expect(GITHUB_CAPABILITIES.filter((capability) => capability.operation === "write"))
      .toHaveLength(1);
    // A capability names a resource instead of taking one, so no schema may
    // carry a repository selector.
    for (const capability of GITHUB_CAPABILITIES) {
      expect(Object.keys(capability.inputSchema.properties)).not.toContain("repository_id");
      expect(capability.inputSchema.required).not.toContain("repository_id");
      expect(capability.resourceTypes).toEqual(["repository"]);
    }
    // Only the write carries authorization, idempotency and readback.
    const issueManage = GITHUB_CAPABILITIES.find((capability) => capability.id === "manage.issue");
    expect(issueManage).toMatchObject({
      operation: "write", requestAuthorization: "current_message",
      idempotency: "required", readback: "required",
    });
    for (const capability of GITHUB_CAPABILITIES) {
      if (capability.operation === "write") continue;
      expect(capability.requestAuthorization).toBe("none");
      expect(capability.idempotency).toBe("none");
      expect(capability.readback).toBe("none");
    }
    // The audited Issue surface is unchanged: one write with 15 typed actions.
    expect(issueManage!.inputSchema.properties.action).toMatchObject({
      enum: [
        "create", "edit", "comment", "assign", "unassign", "add_labels", "remove_labels",
        "set_milestone", "clear_milestone", "close", "reopen", "lock", "unlock",
        "reuse", "force_create",
      ],
    });
    // Capability ids and tool names are exact inverses, so dispatch is total.
    for (const tool of [...READ_ONLY_TOOLS, ISSUE_ACTION_TOOL]) {
      expect(toolNameFor(capabilityIdFor(tool.name))).toBe(tool.name);
    }
  });

  test("pins every reply to the selected profile, bot identity, thread, and idempotency key", () => {
    const command = buildReplyCommand({ cliPath: "/lark-cli", profile: "mochi", configDirectory: "/private/test-config" }, "om_message", "hello");
    expect(command.slice(0, 3)).toEqual(["/lark-cli", "--profile", "mochi"]);
    expect(command).toContain("--reply-in-thread");
    expect(command).toContain("--idempotency-key");
    expect(command.slice(-2)).toEqual(["--as", "bot"]);
  });

  test("pins reaction lifecycle writes to the selected Bot identity", () => {
    const create = buildCreateReactionCommand(
      { cliPath: "/lark-cli", profile: "mochi", configDirectory: "/private/test-config" },
      "om_message",
      "Typing",
    );
    const remove = buildDeleteReactionCommand(
      { cliPath: "/lark-cli", profile: "mochi", configDirectory: "/private/test-config" },
      "om_message",
      "reaction-id",
    );
    expect(create.slice(0, 6)).toEqual([
      "/lark-cli", "--profile", "mochi", "im", "reactions", "create",
    ]);
    expect(create).toContain('{"reaction_type":{"emoji_type":"Typing"}}');
    expect(remove).toContain('{"message_id":"om_message","reaction_id":"reaction-id"}');
    expect(create.slice(-2)).toEqual(["--as", "bot"]);
    expect(remove.slice(-2)).toEqual(["--as", "bot"]);
  });

  test("uses distinct valid reaction states for waiting and blocked outcomes", () => {
    const waiting = buildCreateReactionCommand({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, "om_message", "THINKING");
    const blocked = buildCreateReactionCommand({ cliPath: "/lark-cli", profile: "profile", configDirectory: "/private/test-config" }, "om_message", "FROWN");
    expect(waiting).toContain('{"reaction_type":{"emoji_type":"THINKING"}}');
    expect(blocked).toContain('{"reaction_type":{"emoji_type":"FROWN"}}');
  });

  test("does not pass Runtime, OpenAI, or GitHub credentials to lark-cli", () => {
    const environment = larkEnvironment("/Users/bridge/.nvm/bin/lark-cli", {
      PATH: "/bin",
      HOME: "/Users/bridge",
      AWS_SECRET_ACCESS_KEY: "unrelated-secret",
      OPENAI_API_KEY: "secret",
      GITHUB_APP_PRIVATE_KEY_PATH: "/secret/key.pem",
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      PERMANENT_PI_SESSION_ID: "permanent-session",
      PI_RUNTIME_HOME: "/secret/home",
      PI_WORKER_PATH: "/secret/worker",
    });
    expect(environment.PATH).toBe("/Users/bridge/.nvm/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(environment.HOME).toBe("/Users/bridge");
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    expect(environment.GITHUB_APP_ID).toBeUndefined();
    expect(environment.GITHUB_APP_INSTALLATION_ID).toBeUndefined();
    expect(environment.PERMANENT_PI_SESSION_ID).toBeUndefined();
    expect(environment.PI_RUNTIME_HOME).toBeUndefined();
    expect(environment.PI_WORKER_PATH).toBeUndefined();
  });

  test("launches only the fixed Pi worker as a dedicated user", () => {
    const config: RuntimeConfig = {
      botId: "11111111-2222-4333-8444-555555555555",
      workerPath: "/usr/local/libexec/mochi-pi-runtime",
      sudoPath: "/usr/bin/sudo",
      runtimeUser: "_mochi",
      runtimeHome: "/Users/_mochi",
      runtimeCwd: "/Users/_mochi/empty-workspace",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      turnTimeoutMilliseconds: 600_000,
    };
    const command = runtimeWorkerCommand(config);
    expect(command).toEqual([
      "/usr/bin/sudo", "-n", "-H", "-u", "_mochi", "/usr/local/libexec/mochi-pi-runtime",
    ]);
    expect(runtimeLauncherEnvironment()).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" });

    const digest = "a".repeat(64);
    const sudoers = buildRuntimeSudoersRule("bridge-user", config, digest);
    expect(sudoers).toBe(`bridge-user ALL=(_mochi) CWD=/Users/_mochi/empty-workspace NOPASSWD: sha256:${digest} /usr/local/libexec/mochi-pi-runtime ""\n`);
    expect(sudoers).not.toContain("/usr/bin/sudo");
    expect(() => buildRuntimeSudoersRule("unsafe user", config, digest)).toThrow("unsafe Bridge username");
  });

  test("pins material access inside the compiled worker instead of trusting its caller", () => {
    expect(PI_MATERIAL_ROOT).toBe("/Users/Shared/mochi/materials");
    expect(isFixedPiMaterialRoot(PI_MATERIAL_ROOT)).toBeTrue();
    expect(isFixedPiMaterialRoot("/Users/_mochi")).toBeFalse();
    expect(isFixedPiMaterialRoot("/")).toBeFalse();
  });

  test("neutralizes mention tags and remote image downloads in model output", () => {
    expect(sanitizeMarkdown('![probe](https://example.com/a.png) <at user_id="all"></at> <img src="x">'))
      .toBe('[probe](https://example.com/a.png) &lt;at user_id="all"></at> &lt;img src="x">');
  });
});
