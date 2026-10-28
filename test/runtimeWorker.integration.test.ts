import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_TOOLS, AGENT_TOOL_CAPABILITY_ABI } from "../src/agent/tools.ts";
import { RuntimeTransport } from "../src/runtime/transport.ts";

/** No production test flag: the build replaces paths and the model transport, nothing else. */
test.skipIf(process.platform !== "darwin")(
  "compiled worker preserves a real Session, steering provenance and scheduled/ABI boundaries",
  async () => {
    const root = realpathSync(
      mkdtempSync(join(homedir(), ".mochi-worker-test-")),
    );
    const home = join(root, "home"),
      cwd = join(home, "empty-workspace"),
      materials = join(root, "materials");
    const workspace = join(materials, "turn"),
      binary = join(root, "worker"),
      signal = join(root, "streaming");
    const botId = crypto.randomUUID(),
      sessionId = crypto.randomUUID();
    const account = join(home, ".pi/mochi/account"),
      sessions = join(home, ".pi/mochi/bots", botId, "sessions");
    for (const path of [home, cwd, materials, workspace, account])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(account, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "fixture-no-network",
          refresh: "fixture-no-network",
          expires: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    );
    const events: { event: string; params: Record<string, unknown> }[] = [];
    const relays: Record<string, unknown>[] = [],
      failures: Error[] = [];
    const firstRelay = Promise.withResolvers<void>(),
      releaseRelay = Promise.withResolvers<void>();
    let worker: RuntimeTransport | undefined;
    const initialization = {
      botId,
      sessionId,
      capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      systemPrompt: "Offline integration fixture",
      tools: AGENT_TOOLS,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      materialRoot: materials,
    };
    function start() {
      const transport = new RuntimeTransport({
        command: [
          "/bin/sh",
          "-c",
          'cd "$1" && exec "$2"',
          "worker-fixture",
          cwd,
          binary,
        ],
        environment: {
          HOME: home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          MOCHI_WORKER_TEST_SIGNAL: signal,
        },
        onEvent: (event, params) =>
          events.push({ event, params: params as Record<string, unknown> }),
        onRequest: async (method, params) => {
          expect(method).toBe("tool.execute");
          relays.push(params as Record<string, unknown>);
          if (relays.length === 1) {
            firstRelay.resolve();
            await releaseRelay.promise;
          }
          return {
            ok: true,
            result: { content: [{ type: "text", text: "fixture evidence" }] },
          };
        },
        onFatal: (error) => failures.push(error),
        onExit: () => {},
      });
      transport.start();
      worker = transport;
      return transport;
    }
    async function stop() {
      await worker?.stop(new Error("Fixture stopped"));
      worker = undefined;
    }
    async function completed(turnId: string) {
      await until(() =>
        events.some(
          ({ event, params }) =>
            event === "turn.completed" && params.turnId === turnId,
        ),
      );
      return events.find(
        ({ event, params }) =>
          event === "turn.completed" && params.turnId === turnId,
      )!.params;
    }
    async function turn(text: string, executionPolicy = "interactive") {
      return (await worker!.request("turn.start", {
        sourceMessageId: `message-${events.length}`,
        text,
        images: [],
        workspace,
        systemPrompt: initialization.systemPrompt,
        executionPolicy,
      })) as { turnId: string };
    }
    try {
      const workerPath = resolve("src/runtime/worker.ts");
      const build = await Bun.build({
        entrypoints: [workerPath],
        compile: { outfile: binary },
        plugins: [
          {
            name: "offline-worker-fixture",
            setup(builder) {
              builder.onLoad(
                { filter: /\/src\/runtime\/constants\.ts$/ },
                ({ path }) => ({
                  contents: readFileSync(path, "utf8")
                    .replace('"/Users/_mochi"', JSON.stringify(home))
                    .replace(
                      '"/Users/_mochi/empty-workspace"',
                      JSON.stringify(cwd),
                    )
                    .replace(
                      '"/Users/Shared/mochi/materials"',
                      JSON.stringify(materials),
                    ),
                  loader: "ts",
                }),
              );
              builder.onResolve(
                { filter: /^@earendil-works\/pi-coding-agent$/ },
                ({ importer }) =>
                  importer === workerPath
                    ? { path: resolve("test/fixtures/scriptedPi.ts") }
                    : undefined,
              );
            },
          },
        ],
      });
      if (!build.success) throw new Error(build.logs.join("\n"));
      await start().request("runtime.initialize", initialization);
      expect(await worker!.request("session.bootstrap", {})).toEqual({
        sessionId,
        capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      });
      await stop();
      const files = readdirSync(sessions).filter((name) =>
        name.endsWith(".jsonl"),
      );
      expect(files).toHaveLength(1);
      const sessionFile = join(sessions, files[0]!);
      const bootstrap = readFileSync(sessionFile, "utf8");
      expect(bootstrap).toContain("READY");
      await start().request("runtime.initialize", initialization);
      const historyBeforeVerification = readdirSync(sessions).filter(name => name.endsWith(".jsonl")).map(name => readFileSync(join(sessions, name), "utf8"));
      expect(await worker!.request("session.verify", {})).toEqual({ sessionId, capabilityAbi: AGENT_TOOL_CAPABILITY_ABI });
      expect(readdirSync(sessions).filter(name => name.endsWith(".jsonl")).map(name => readFileSync(join(sessions, name), "utf8"))).toEqual(historyBeforeVerification);
      expect(await worker!.request("session.resume", {})).toEqual({
        sessionId,
        capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      });
      await expect(worker!.request("account.initialize", {})).rejects.toThrow();
      const active = await turn("probe:first");
      await firstRelay.promise;
      await worker!.request("turn.steer", {
        turnId: active.turnId,
        sourceMessageId: "message-second",
        text: "probe:second",
        images: [],
      });
      await worker!.request("turn.steer", {
        turnId: active.turnId,
        sourceMessageId: "message-third",
        text: "probe:third",
        images: [],
      });
      releaseRelay.resolve();
      expect((await completed(active.turnId)).status).toBe("completed");
      expect(relays.map((relay) => relay.sourceMessageId)).toEqual([
        "message-0",
        "message-second",
        "message-third",
      ]);
      const scheduled = await turn("probe:write", "scheduled");
      const scheduledResult = await completed(scheduled.turnId);
      expect(scheduledResult.status).toBe("completed");
      expect(scheduledResult.text).toContain(
        "Scheduled work cannot invoke writes",
      );
      expect(relays).toHaveLength(3);
      const failed = await turn("probe:failure");
      expect((await completed(failed.turnId)).status).not.toBe("completed");
      const aborting = await turn("probe:abort");
      await until(() => existsSync(signal));
      await worker!.request("turn.abort", { turnId: aborting.turnId });
      expect((await completed(aborting.turnId)).status).not.toBe("completed");
      await stop();
      await start().request("runtime.initialize", initialization);
      expect(await worker!.request("session.resume", {})).toEqual({
        sessionId,
        capabilityAbi: AGENT_TOOL_CAPABILITY_ABI,
      });
      const recovered = await turn("probe:recovered");
      expect((await completed(recovered.turnId)).status).toBe("completed");
      await stop();
      const history = readFileSync(sessionFile, "utf8");
      expect(history.startsWith(bootstrap)).toBeTrue();
      for (const text of [
        "probe:first",
        "probe:second",
        "probe:third",
        "probe:abort",
      ])
        expect(history).toContain(text);
      expect(
        readdirSync(sessions).filter((name) => name.endsWith(".jsonl")),
      ).toEqual(files);
      expect(
        readdirSync(join(home, ".pi/mochi/bots", botId, "execution")),
      ).toHaveLength(0);
      await start().request("runtime.initialize", {
        ...initialization,
        capabilityAbi: `sha256:${"0".repeat(64)}`,
      });
      await expect(worker!.request("session.resume", {})).rejects.toThrow(
        "capability mismatch",
      );
      expect(readFileSync(sessionFile, "utf8")).toBe(history);
      expect(failures).toEqual([]);
    } finally {
      releaseRelay.resolve();
      await stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline)
      throw new Error("Worker fixture condition timed out");
    await Bun.sleep(10);
  }
}
