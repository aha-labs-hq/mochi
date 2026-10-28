import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeBotDirectory } from "../src/runtime/storage.ts";
import { resolveProductLayout } from "../src/product/layout.ts";
import { Fleet } from "../src/product/fleet.ts";

const A = "11111111-1111-4111-8111-111111111111";
const cleanup: string[] = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function home() { const path = realpathSync(mkdtempSync(join(tmpdir(), "mochi-independent-"))); cleanup.push(path); return path; }
test("a Fleet with an injected record path provisions only that deployment",()=> {
  const root=home();const fleet=new Fleet(join(root,"fleet.json"));const bot=fleet.create("独立");
  expect(fleet.layout(bot.id).stateDirectory).toBe(join(root,"Bots",bot.id,"State"));
  expect(existsSync(fleet.layout(bot.id).configurationDirectory)).toBe(true);
});

test("a Bot character selection persists independently and rejects unknown characters",()=> {
 const root=home(),path=join(root,"fleet.json"),fleet=new Fleet(path),bot=fleet.create("形象");
 expect(fleet.setCharacter(bot.id,"awawa").characterId).toBe("awawa");
 expect(new Fleet(path).bots()[0]?.characterId).toBe("awawa");
 expect(()=>fleet.setCharacter(bot.id,"capybara")).toThrow("Unknown Bot character");
});

test("runtime namespaces reject ambient instructions",()=>{
 const root=home();const path=runtimeBotDirectory(root,A);writeFileSync(join(path,"AGENTS.md"),"ambient",{mode:0o600});
 expect(()=>runtimeBotDirectory(root,A)).toThrow("forbidden ambient");
});

test("a remote Feishu Bot cannot be adopted by another independent Bot",async()=>{
 const {assertFeishuOwnership}=await import("../src/lark/productConnection.ts");
 const {FeishuConnectionStore}=await import("../src/lark/connectionStore.ts");
 const root=home(),layout=resolveProductLayout({environment:{},homeDirectory:root});
 const fleet=new Fleet(layout.fleetRecordPath);const a=fleet.create("A"),b=fleet.create("B");
 new FeishuConnectionStore(layout.bot(a.id).feishuConnectionDirectory).write({version:2,active:{brand:"feishu",directoryId:crypto.randomUUID(),appId:"cli_unique",botOpenId:"ou_unique"},candidate:null});
 expect(()=>assertFeishuOwnership(layout,b.id,"cli_unique")).toThrow("bot_already_connected");
 expect(()=>assertFeishuOwnership(layout,a.id,"cli_unique")).not.toThrow();
 expect(()=>assertFeishuOwnership(layout,b.id,"cli_another")).not.toThrow();
});

test("a Bot is not published until its initial configuration is ready",()=>{
 const root=home(),fleet=new Fleet(join(root,"fleet.json"));
 expect(()=>fleet.create("incomplete",()=>{throw Error("invalid templates");})).toThrow("invalid templates");
 expect(fleet.bots()).toEqual([]);
 const bot=fleet.create("ready",layout=>{writeFileSync(layout.botConfigPath,"prepared",{mode:0o600});expect(fleet.bots()).toEqual([]);});
 expect(bot.enabled).toBe(false);
 expect(readFileSync(fleet.layout(bot.id).botConfigPath,"utf8")).toBe("prepared");
});
