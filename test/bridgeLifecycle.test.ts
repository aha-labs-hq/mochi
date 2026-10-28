import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "../src/bridge.ts";
import { Fleet } from "../src/product/fleet.ts";
import { INSTALLED_PRODUCT_ROOT, resolveProductLayout } from "../src/product/layout.ts";
import { readFleetStatusSnapshot } from "../src/control/statusSnapshot.ts";
import { ProcessLock } from "../src/processLock.ts";
import { killLockHolder } from "./lockHolder.ts";
import { RuntimeAccountClient } from "../src/runtime/accountClient.ts";
class SignedOutAccountClient extends RuntimeAccountClient {
 override async accountRead() { return { status: "signedOut" as const }; }
}
const clean: (()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const f of clean.splice(0).reverse()) await f();});
function fixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"mochi-host-")));clean.push(()=>rmSync(root,{recursive:true,force:true}));
 const layout=resolveProductLayout({environment:{},homeDirectory:root});
 // Keep the isolated fixture's Unix socket below macOS's path limit.
 layout.controlSocketPath=join(root,"control.sock");
 mkdirSync(layout.mutableRoot,{recursive:true,mode:0o700});
 let resets=0;const bridge=new Bridge(layout,()=>{resets++;},observer=>new SignedOutAccountClient(observer));clean.push(()=>bridge.stop());
 const fleet=new Fleet(layout.fleetRecordPath);
 return {layout,bridge,fleet,resets:()=>resets};
}
async function until(predicate:()=>boolean){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error("Host did not converge");await Bun.sleep(10);}}
test("an empty host serves control and releases its lock during immediate shutdown",async()=>{
 const f=fixture();const running=f.bridge.start();
 await until(()=>{const r=readFleetStatusSnapshot(f.layout.statusSnapshotPath);return r.kind==="current" && r.snapshot.controlAvailable;});
 const status=readFleetStatusSnapshot(f.layout.statusSnapshotPath);if(status.kind!=="current")throw Error("no status");
 expect(status.snapshot.runtimeAccount).toEqual({status:"signedOut"});
 expect(f.resets()).toBe(1);
 await f.bridge.stop();await running;
 const lock=await ProcessLock.acquire(f.layout.deploymentLockPath);await lock.release();
 const early=fixture();const starting=early.bridge.start();await early.bridge.stop();await starting;
 const released=await ProcessLock.acquire(early.layout.deploymentLockPath);await released.release();
});
test("one invalid Bot cannot prevent the host from publishing another Bot or serving control",async()=>{
 const f=fixture();const a=f.fleet.create("A"),b=f.fleet.create("B");
 const running=f.bridge.start();
 await until(()=>{const r=readFleetStatusSnapshot(f.layout.statusSnapshotPath);return r.kind==="current" && r.snapshot.bots.every(bot=>bot.lifecycle==="failed");});
 const r=readFleetStatusSnapshot(f.layout.statusSnapshotPath);expect(r.kind).toBe("current");if(r.kind!=="current")throw Error("no status");
 expect(r.snapshot.controlAvailable).toBe(true);expect(r.snapshot.bots.map(bot=>bot.botId)).toEqual([a.id,b.id]);
 await f.bridge.bot(a.id).setBotEnabled(false);
 const paused=readFleetStatusSnapshot(f.layout.statusSnapshotPath);if(paused.kind!=="current")throw Error("no status");
 expect(paused.snapshot.bots[0]!.lifecycle).toBe("paused");expect(paused.snapshot.bots[1]!.lifecycle).toBe("failed");
 await f.bridge.stop();await running;
});
test("the deployment lock sits beside the status and control files both modes share",()=>{
 const root="/Users/test";
 const development=resolveProductLayout({environment:{},homeDirectory:root});
 const installed=resolveProductLayout({environment:{MOCHI_PRODUCT_ROOT:INSTALLED_PRODUCT_ROOT},homeDirectory:root});
 for(const layout of [development,installed]) {
  expect(layout.deploymentLockPath).toBe(join(root,"Library","Application Support","Mochi","bot.lock"));
  expect(join(layout.deploymentLockPath,"..")).toBe(join(layout.statusSnapshotPath,".."));
  expect(join(layout.deploymentLockPath,"..")).toBe(join(layout.controlSocketPath,".."));
 }
});
test("a Bridge refused by the lock never writes the lock holder's status",async()=>{
 const f=fixture();const running=f.bridge.start();
 await until(()=>{const r=readFleetStatusSnapshot(f.layout.statusSnapshotPath);return r.kind==="current" && r.snapshot.controlAvailable;});
 const before=readFileSync(f.layout.statusSnapshotPath,"utf8");
 const second=new Bridge(f.layout,()=>{},observer=>new SignedOutAccountClient(observer));
 await expect(second.start()).rejects.toThrow("already owns");
 second.fail("bridge_startup_failed");await second.stop();
 const after=readFleetStatusSnapshot(f.layout.statusSnapshotPath);if(after.kind!=="current")throw Error("no status");
 expect(after.snapshot.processId).toBe(process.pid);expect(after.snapshot.controlAvailable).toBe(true);
 expect(JSON.parse(before).runId).toBe(after.snapshot.runId);
 await f.bridge.stop();await running;
});
test("a Bridge that loses its deployment lock stops writing and serving at once",async()=>{
 const f=fixture();const running=f.bridge.start().then(()=>null,(error:Error)=>error);
 await until(()=>{const r=readFleetStatusSnapshot(f.layout.statusSnapshotPath);return r.kind==="current" && r.snapshot.controlAvailable;});
 killLockHolder(f.layout.deploymentLockPath);
 expect((await running)?.name).toBe("BridgeLockLostError");
 const last=readFileSync(f.layout.statusSnapshotPath,"utf8");
 // The last write still claims control: nothing after the loss was written,
 // so a replacement Bridge alone decides what the file says next.
 expect(JSON.parse(last).controlAvailable).toBe(true);
 await Bun.sleep(5_200);
 expect(readFileSync(f.layout.statusSnapshotPath,"utf8")).toBe(last);
 expect(existsSync(f.layout.controlSocketPath)).toBe(true);
 const replacement=await ProcessLock.acquire(f.layout.deploymentLockPath);await replacement.release();
},15_000);
