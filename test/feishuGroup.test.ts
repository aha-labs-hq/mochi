import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFeishuGroups, isGroupAvatarUrl, type FeishuGroup } from "../src/lark/group.ts";
import { FeishuGroups, parseBotGroups } from "../src/lark/groups.ts";
import { StateStore } from "../src/state.ts";
import { log, memoryLogSink, setLogSink } from "../src/log.ts";
import type { runLarkJson } from "../src/lark/process.ts";

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });
const config = { cliPath: "/native/lark-cli", profile: "mochi", configDirectory: "/private/test-config", targetAppId: "cli_bot" };
const avatar = "https://s1-imfile.feishucdn.com/static-resource/v1/avatar";
const row = (id = "oc_one", name: unknown = "测试群") => ({ chat_id: id, name, avatar, chat_mode: "group", chat_status: "normal", owner_id: "private" });
const inventory = (chats: unknown[] = [row()]) => ({
  ok: true, identity: "bot", data: { chats, has_more: false }, meta: { pagination: { complete: true } },
});

function fixture(read: typeof runLarkJson) {
  const directory = mkdtempSync(join(tmpdir(), "mochi-groups-"));
  const path = join(directory, "state.sqlite");
  const state = new StateStore(path);
  const values: (readonly FeishuGroup[] | null)[] = [];
  const groups = new FeishuGroups(config, state, (value) => values.push(value), log.with({ botId: "bot-a" }), read);
  disposals.push(() => { groups.stop(); state.close(); rmSync(directory, { recursive: true }); });
  return { groups, values, state, path };
}

test("all joined groups default on; names/avatars are metadata, not a static enrollment gate", async () => {
  const calls: unknown[] = [];
  let response = inventory([row(), row("oc_two", "Second")]);
  const f = fixture(async (...args) => { calls.push(args); return response; });
  await f.groups.start();
  expect(calls).toEqual([[config, ["im", "+chat-list", "--as", "bot", "--page-all", "--page-size", "100", "--page-limit", "10", "--json"]]]);
  expect(f.groups.snapshot()).toEqual([
    { id: "oc_one", name: "测试群", avatarUrl: avatar, enabled: true },
    { id: "oc_two", name: "Second", avatarUrl: avatar, enabled: true },
  ]);
  expect(await f.groups.accepts("oc_one")).toBe(true);
  response = inventory([row(), row("oc_two"), row("oc_new")]);
  expect(await f.groups.accepts("oc_new")).toBe(true);
  expect(f.groups.snapshot()).toHaveLength(3);
  expect(await f.groups.accepts("oc_stranger")).toBe(false);
});

test("manual off persists across restart, leave/rejoin and rename, but never affects another bot", async () => {
  let response = inventory();
  const f = fixture(async () => response);
  await f.groups.start();
  f.groups.setEnabled("oc_one", false);
  expect(await f.groups.accepts("oc_one")).toBe(false);
  expect(f.state.groupEnabled("cli_other", "oc_one")).toBe(true);
  response = inventory([]);
  await f.groups.refresh();
  expect(f.groups.snapshot()).toEqual([]);
  expect(() => f.groups.setEnabled("oc_one", true)).toThrow("membership");
  response = inventory([row("oc_one", "Renamed")]);
  await f.groups.refresh();
  expect(f.groups.snapshot()?.[0]).toMatchObject({ name: "Renamed", enabled: false });
  const reopened = new StateStore(f.path);
  expect(reopened.groupEnabled("cli_bot", "oc_one")).toBe(false);
  reopened.close();
  f.groups.setEnabled("oc_one", true);
  expect(await f.groups.accepts("oc_one")).toBe(true);
});

test("failed or incomplete discovery fails closed, preserves off choices, and can refresh without restart", async () => {
  let response: unknown = inventory([row(), row("oc_two")]);
  const f = fixture(async () => response);
  await f.groups.start();
  f.groups.setEnabled("oc_two", false);
  for (const invalid of [
    { ...inventory(), identity: "user" }, { ok: false },
    { ...inventory(), meta: { pagination: { complete: false } } },
    { ...inventory(), data: { chats: [row()], has_more: true } },
    inventory([row(), row()]), inventory([row("bad")]),
    inventory([row("oc_one", "a\nforged")]), inventory([row("oc_one", "x".repeat(513))]),
    inventory([{ ...row(), chat_mode: "p2p" }]),
  ]) {
    response = invalid;
    expect(await f.groups.refresh()).toBe(false);
    expect(f.groups.snapshot()).toBeNull();
    expect(await f.groups.accepts("oc_one")).toBe(false);
    expect(() => f.groups.setEnabled("oc_one", true)).toThrow();
  }
  response = inventory([row(), row("oc_two")]);
  expect(await f.groups.refresh()).toBe(true);
  expect(await f.groups.accepts("oc_one")).toBe(true);
  expect(await f.groups.accepts("oc_two")).toBe(false);
});

test("after a failed refresh the next message proves membership itself instead of waiting for the minute recheck", async () => {
  let response: unknown = { ok: false };
  let calls = 0;
  const f = fixture(async () => { calls++; return response; });
  await f.groups.start();
  expect(f.groups.snapshot()).toBeNull();
  response = inventory();
  expect(await f.groups.accepts("oc_one")).toBe(true);
  expect(calls).toBe(2);
  expect(f.groups.snapshot()).toEqual([{ id: "oc_one", name: "测试群", avatarUrl: avatar, enabled: true }]);
  // While Feishu still cannot confirm the directory, each message is refused after its own attempt.
  response = { ok: false };
  expect(await f.groups.refresh()).toBe(false);
  expect(await f.groups.accepts("oc_one")).toBe(false);
  expect(calls).toBe(4);
});

test("a turn learns the group's directory name; an unnamed or unconfirmed group is unknown, never guessed", async () => {
  let response: unknown = inventory([row(), row("oc_unnamed", "")]);
  const f = fixture(async () => response);
  await f.groups.start();
  expect(f.groups.name("oc_one")).toBe("测试群");
  expect(f.groups.name("oc_unnamed")).toBeNull();
  expect(f.groups.name("oc_stranger")).toBeNull();
  response = { ok: false };
  expect(await f.groups.refresh()).toBe(false);
  expect(f.groups.name("oc_one")).toBeNull();
});

test("coalesces reads and waits for membership proof; stop discards an in-flight result", async () => {
  const pending = Promise.withResolvers<unknown>();
  let calls = 0;
  const f = fixture(async () => { calls++; return pending.promise; });
  const started = f.groups.start();
  const refresh = f.groups.refresh();
  const accepts = f.groups.accepts("oc_one");
  expect(calls).toBe(1);
  f.groups.stop();
  pending.resolve(inventory());
  await started;
  expect(await refresh).toBe(false);
  expect(await accepts).toBe(false);
  expect(f.values).toEqual([]);
  await expect(f.groups.start()).rejects.toThrow("already started");
});

test("the minute recheck logs the inventory only when it changes, always naming the Bot", async () => {
  let response = inventory([row(), row("oc_two")]);
  const f = fixture(async () => response);
  const sink = memoryLogSink();
  const previous = setLogSink(sink);
  try {
    await f.groups.start();
    await f.groups.refresh();
    await f.groups.refresh();
    response = inventory([row(), row("oc_three")]);
    await f.groups.refresh();
    f.groups.setEnabled("oc_one", false);
    await f.groups.refresh();
    response = { ...inventory(), ok: false } as typeof response;
    await f.groups.refresh();
    response = inventory([row(), row("oc_three")]);
    await f.groups.refresh();
  } finally { setLogSink(previous); }
  const groups = sink.records.filter((record) => record.event.startsWith("lark.group"));
  expect(groups.map(({ event, count, enabledCount, addedCount, removedCount }) =>
    [event, count, enabledCount, addedCount, removedCount])).toEqual([
    ["lark.groups.resolved", 2, 2, 2, 0],
    ["lark.groups.resolved", 2, 2, 1, 1],
    ["lark.group.participation_changed", undefined, undefined, undefined, undefined],
    ["lark.groups.resolved", 2, 1, 0, 0],
    ["lark.groups.unavailable", undefined, undefined, undefined, undefined],
    ["lark.groups.resolved", 2, 1, 2, 0],
  ]);
  expect(groups.every((record) => record.botId === "bot-a")).toBeTrue();
  expect(JSON.stringify(groups)).not.toContain("测试群");
});

test("failed persistence never flips UI facts or the intake gate", async () => {
  const values: unknown[] = [];
  const groups = new FeishuGroups(config, {
    groupEnabled: () => true,
    setGroupEnabled: () => { throw new Error("disk unavailable"); },
  }, (value) => values.push(value), log, async () => inventory());
  disposals.push(() => groups.stop());
  await groups.start();
  expect(() => groups.setEnabled("oc_one", false)).toThrow("disk unavailable");
  expect(await groups.accepts("oc_one")).toBe(true);
  expect(values).toHaveLength(1);
});

test("avatar failures do not deny groups; strict renderer schema rejects arbitrary URLs and extra metadata", () => {
  for (const url of ["file:///etc/passwd", "http://localhost/a", "https://s1-imfile.feishucdn.com.evil.test/a", "https://user:pass@s1-imfile.feishucdn.com/a", "https://s1-imfile.feishucdn.com:444/a"]) {
    expect(isGroupAvatarUrl(url)).toBe(false);
    expect(parseBotGroups(inventory([{ ...row(), avatar: url }]))[0]?.avatarUrl).toBeNull();
  }
  const group = { id: "oc_one", name: null, avatarUrl: null, enabled: false };
  expect(isFeishuGroups([group])).toBe(true);
  expect(isFeishuGroups([group, group])).toBe(false);
  expect(isFeishuGroups([{ ...group, credential: "hidden" }])).toBe(false);
  expect(isFeishuGroups([{ ...group, enabled: "true" }])).toBe(false);
  expect(isFeishuGroups(Array.from({ length: 1_001 }, (_, i) => ({ ...group, id: `oc_${i}` })))).toBe(false);
  expect(parseBotGroups(inventory([row("oc_one", "")]))[0]?.name).toBeNull();
});
