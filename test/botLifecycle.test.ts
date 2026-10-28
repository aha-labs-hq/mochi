import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotApp } from "../src/app.ts";
import { FleetStatusProjection, readFleetStatusSnapshot } from "../src/control/statusSnapshot.ts";
import { GitHubOAuth } from "../src/github/oauth.ts";
import { GitHubConnection } from "../src/github/connection.ts";
import { GitHubFileCredentialStore } from "../src/github/credentials.ts";
import { FeishuConnection } from "../src/lark/connection.ts";
import { FeishuConnectionStore } from "../src/lark/connectionStore.ts";
import { ProcessLock } from "../src/processLock.ts";
import { StateStore } from "../src/state.ts";
import { loadBotContextBeforeSetup } from "../src/config.ts";
import { resolveProductLayout } from "../src/product/layout.ts";
import { AGENT_TOOL_CAPABILITY_ABI } from "../src/agent/tools.ts";
import { SharedRuntimeAccount } from "../src/runtime/sharedAccount.ts";
import { RuntimeAccountClient } from "../src/runtime/accountClient.ts";

const dispose: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of dispose.splice(0).reverse()) await fn();});
const A="11111111-1111-4111-8111-111111111111", B="22222222-2222-4222-8222-222222222222";
async function until(predicate:()=>boolean) {const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw Error("Lifecycle did not converge");await Bun.sleep(10);}}
async function fixture() {
 const root=realpathSync(mkdtempSync(join(tmpdir(),"mochi-bot-lifecycle-")));dispose.push(()=>rmSync(root,{recursive:true,force:true}));
 const layout=resolveProductLayout({environment:{},homeDirectory:root});
 const status=new FleetStatusProjection(join(root,"status.json"));dispose.push(()=>status.stopping());
 const records=[A,B].map(id=>({id,label:id===A?"麻薯":"伙伴",characterId:"mochi",enabled:false}));status.roster(records);status.controlReady();
 const launcher=join(root,"worker.ts");writeFileSync(launcher,`#!${process.execPath}\n${worker}`,{mode:0o700});
 const bots:BotApp[]=[];
 let admission=Promise.resolve();
 const account=new SharedRuntimeAccount({
  serialize: <T>(operation:()=>Promise<T>)=>{const result=admission.then(operation);admission=result.then(()=>undefined,()=>undefined);return result;},
  participants:()=>bots,
  publish:snapshot=>status.accountChanged(snapshot),
 },observer=>new RuntimeAccountClient(observer,[process.execPath,launcher,root]));
 dispose.push(()=>account.close());await account.start();
 for(const id of [A,B]) {
  const bot=layout.bot(id);mkdirSync(bot.configurationDirectory,{recursive:true,mode:0o700});mkdirSync(bot.stateDirectory,{recursive:true,mode:0o700});
  writeFileSync(bot.botConfigPath,'[agent]\ninstructions_file = "AGENTS.md"\n[runtime]\nmodel = "gpt-test"\nreasoning_effort = "high"\nturn_timeout_seconds = 1800\n',{mode:0o600});
  writeFileSync(join(bot.configurationDirectory,"AGENTS.md"),`Only ${id}`,{mode:0o600});
  const state=new StateStore(bot.stateDatabasePath);const session=state.prepareRuntimeSetupSession(crypto.randomUUID());state.close();
  const context=loadBotContextBeforeSetup(bot,session);context.runtime.sudoPath=launcher;context.runtime.workerPath=root;
  const github=new GitHubConnection({store:new GitHubFileCredentialStore(bot.githubCredentialPath),oauth:new GitHubOAuth("fixture",(async()=>{throw Error("unexpected network");}) as unknown as typeof fetch)});
  const feishu=new FeishuConnection("/unused",new FeishuConnectionStore(bot.feishuConnectionDirectory));
  const app=new BotApp({bot:context,github,feishu,status:status.bot(id),enabled:false,lock:await ProcessLock.acquire(bot.stateLockPath),account});bots.push(app);dispose.push(()=>app.stop());
  void app.start().catch(()=>app.fail());
 }
 await until(()=>status.snapshot().bots.every(bot=>bot.setup?.stage==="signIn"));
 const snapshot=(id:string)=>{expect(readFleetStatusSnapshot(join(root,"status.json")).kind).toBe("current");return status.snapshot().bots.find(bot=>bot.botId===id)!;};
 const enabled=(id:string,value:boolean)=>bots[[A,B].indexOf(id)]!.setEnabled(value,()=>{records.find(bot=>bot.id===id)!.enabled=value;status.roster(records);expect(readFleetStatusSnapshot(join(root,"status.json")).kind).toBe("current");});
 return {root,layout,status,bots,snapshot,enabled,account};
}
test("two real BotApps share one login and preserve separate Sessions across pause and account changes",async()=>{
 const f=await fixture();
 await expect(f.enabled(A,true)).rejects.toThrow("account_required");
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready" && f.snapshot(B).setup?.stage==="ready");
 expect(f.status.snapshot().runtimeAccount.status).toBe("signedIn");
 for(const id of [A,B]) {
  expect(existsSync(join(f.root,`${id}.session`))).toBe(false);
  const pending=new StateStore(f.layout.bot(id).stateDatabasePath);
  expect(pending.runtimeSession()).toBeUndefined();pending.close();
 }
 await f.enabled(A,true);expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
 const state=new StateStore(f.layout.bot(A).stateDatabasePath);const original=state.runtimeSession()!;state.close();
 expect(original.capabilityAbi).toBe(AGENT_TOOL_CAPABILITY_ABI);
 await f.enabled(B,true);
 const beforeB=structuredClone(f.snapshot(B));
 await f.enabled(A,false);expect(f.snapshot(A).lifecycle).toBe("paused");expect(f.snapshot(B)).toEqual(beforeB);
 await f.enabled(A,true);expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
 await f.account.logoutChatGPT();expect(f.snapshot(A).lifecycle).toBe("awaitingLogin");expect(f.snapshot(B).lifecycle).toBe("awaitingLogin");
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).lifecycle==="awaitingConnection" && f.snapshot(B).lifecycle==="awaitingConnection");
 const check=new StateStore(f.layout.bot(A).stateDatabasePath);expect(check.runtimeSession()?.sessionId).toBe(original.sessionId);check.close();
 const trace=readFileSync(join(f.root,`${A}.trace`),"utf8");expect(trace.match(/session.bootstrap/g)).toHaveLength(1);expect(trace.match(/session.resume/g)!.length).toBeGreaterThanOrEqual(4);
 expect(trace).not.toContain(B);
 expect(trace).not.toContain("account.login");expect(trace).not.toContain("account.logout");
 const accountTrace=readFileSync(join(f.root,"account.trace"),"utf8");expect(accountTrace).not.toContain("session.");
});
test("a worker exit clears only its Bot status and pause/resume verifies the same Session",async()=>{
 const f=await fixture();
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready" && f.snapshot(B).setup?.stage==="ready");await f.enabled(A,true);
 const beforeB=structuredClone(f.snapshot(B));
 const workerPid=Number(readFileSync(join(f.root,`${A}.pid`),"utf8"));process.kill(workerPid,"SIGTERM");
 await until(()=>f.snapshot(A).lifecycle==="blocked");expect(f.snapshot(B)).toEqual(beforeB);
 await f.enabled(A,false);await f.enabled(A,true);expect(f.status.snapshot().runtimeAccount.status).toBe("signedIn");expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
});
test("failed first duty start preserves its candidate, keeps duty off and retries the same Session",async()=>{
 const f=await fixture();
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready");
 const state=new StateStore(f.layout.bot(A).stateDatabasePath);const candidate=state.runtimeSetupSessionId();state.close();
 const beforeB=structuredClone(f.snapshot(B));
 writeFileSync(join(f.root,`${A}.fail-resume`),"fail");
 await expect(f.enabled(A,true)).rejects.toThrow("setup_failed");
 expect(f.snapshot(A).enabled).toBe(false);expect(f.snapshot(A).problem?.code).toBe("setup_failed");
 expect(f.snapshot(A).setup?.stage).toBe("ready");expect(f.snapshot(B)).toEqual(beforeB);
 const failed=new StateStore(f.layout.bot(A).stateDatabasePath);
 expect(failed.runtimeSession()).toBeUndefined();expect(failed.runtimeSetupSessionId()).toBe(candidate);failed.close();
 rmSync(join(f.root,`${A}.fail-resume`));
 await f.enabled(A,true);
 const resumed=new StateStore(f.layout.bot(A).stateDatabasePath);
 expect(resumed.runtimeSession()?.sessionId).toBe(candidate);expect(resumed.runtimeSetupSessionId()).toBeUndefined();resumed.close();
 expect(f.snapshot(A).enabled).toBe(true);expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
 expect(readFileSync(join(f.root,`${A}.session`),"utf8")).toBe(candidate!);
});
test("account loss during first startup never enables duty or publishes signed-in setup",async()=>{
 const f=await fixture();
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready");
 const hold=join(f.root,`${A}.hold-bootstrap`);writeFileSync(hold,"hold");
 const starting=f.enabled(A,true).then(()=>null,error=>error as Error);
 await until(()=>f.snapshot(A).setup?.stage==="initializing");
 process.kill(Number(readFileSync(join(f.root,"account.pid"),"utf8")),"SIGTERM");
 await until(()=>f.status.snapshot().runtimeAccount.status==="unknown");
 rmSync(hold);expect((await starting)?.message).toBe("account_status_unavailable");
 expect(f.snapshot(A).enabled).toBe(false);expect(f.snapshot(A).problem?.code).toBe("account_status_unavailable");
 expect(f.snapshot(A).setup).toBeUndefined();
});
test("a failed duty write stays off and the next start resumes its verified Session",async()=>{
 const f=await fixture();
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready");
 await expect(f.bots[0]!.setEnabled(true,()=>{throw Error("disk write failed");})).rejects.toThrow("bot_activation_failed");
 expect(f.snapshot(A).enabled).toBe(false);expect(f.snapshot(A).lifecycle).toBe("blocked");
 const state=new StateStore(f.layout.bot(A).stateDatabasePath);const original=state.runtimeSession()!;state.close();
 await f.enabled(A,true);
 const resumed=new StateStore(f.layout.bot(A).stateDatabasePath);expect(resumed.runtimeSession()?.sessionId).toBe(original.sessionId);resumed.close();
 expect(readFileSync(join(f.root,`${A}.trace`),"utf8").match(/session.bootstrap/g)).toHaveLength(1);
});
test("connection changes retain each Bot policy and resume the same Session after explicit model selection",async()=>{
 const f=await fixture();
 await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready");
 await f.enabled(A,true);
 const original=readFileSync(join(f.root,`${A}.session`),"utf8");
 await f.account.logoutChatGPT();
 await f.account.configureByok({baseUrl:"https://example.com/v1",model:"gpt-test",label:"Test",apiKey:"fixture-key"});
 expect(f.snapshot(A).problem?.code).toBe("model_policy_unavailable");
 expect(f.snapshot(A).botPolicy.model).toBe("gpt-test");
 expect(f.snapshot(B).botPolicy.model).toBe("gpt-test");
 expect((await f.bots[0]!.modelCatalog())[0]?.id).toBe("mochi-byok/gpt-test");
 await f.bots[0]!.updateModelPolicy({model:"mochi-byok/gpt-test",reasoningEffort:"high"});
 expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
 expect(f.snapshot(A).problem).toBeUndefined();
 expect(f.snapshot(B).botPolicy.model).toBe("gpt-test");
 await f.account.removeByok();await f.account.startChatGPTLogin();
 await until(()=>f.snapshot(A).problem?.code==="model_policy_unavailable");
 await f.bots[0]!.updateModelPolicy({model:"gpt-test",reasoningEffort:"high"});
 expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
 expect(readFileSync(join(f.root,`${A}.session`),"utf8")).toBe(original);
 expect(readFileSync(join(f.root,`${A}.trace`),"utf8").match(/session.bootstrap/g)).toHaveLength(1);
});
test("BYOK first duty requires a matching model and keeps the prepared Session candidate",async()=>{
 const f=await fixture();
 await f.account.configureByok({baseUrl:"https://example.com/v1",model:"gpt-test",label:"Test",apiKey:"fixture-key"});
 await expect(f.enabled(A,true)).rejects.toThrow("model_policy_unavailable");
 expect(f.snapshot(A).enabled).toBeFalse();
 expect(existsSync(join(f.root,`${A}.session`))).toBeFalse();
 await f.bots[0]!.updateModelPolicy({model:"mochi-byok/gpt-test",reasoningEffort:"high"});
 expect(f.snapshot(A).setup?.stage).toBe("ready");
 expect(f.snapshot(A).problem).toBeUndefined();
 await f.enabled(A,true);
 expect(f.snapshot(A).enabled).toBeTrue();
});
test("failed reactivation after model selection reports failure while retaining the saved policy",async()=>{
 const f=await fixture();await f.account.startChatGPTLogin();await until(()=>f.snapshot(A).setup?.stage==="ready");await f.enabled(A,true);
 await f.account.logoutChatGPT();await f.account.configureByok({baseUrl:"https://example.com/v1",model:"gpt-test",label:"Test",apiKey:"fixture-key"});
 writeFileSync(join(f.root,`${A}.fail-resume`),"fail");
 await expect(f.bots[0]!.updateModelPolicy({model:"mochi-byok/gpt-test",reasoningEffort:"high"})).rejects.toThrow("runtime_session_unavailable");
 expect(f.snapshot(A).botPolicy.model).toBe("mochi-byok/gpt-test");
 expect(f.snapshot(A).problem?.code).toBe("runtime_session_unavailable");
 rmSync(join(f.root,`${A}.fail-resume`));await f.enabled(A,true);
 expect(f.snapshot(A).lifecycle).toBe("awaitingConnection");
});
const worker=String.raw`
import {existsSync,readFileSync,writeFileSync,appendFileSync} from "node:fs";
import {join} from "node:path";
const root=process.argv.at(-1);let init;let login;
function send(request,result){process.stdout.write(JSON.stringify({version:11,type:"response",id:request.id,ok:true,result})+"\n");}
function reject(request,code){process.stdout.write(JSON.stringify({version:11,type:"response",id:request.id,ok:false,error:{code,message:code}})+"\n");}
function event(name,params){process.stdout.write(JSON.stringify({version:11,type:"event",event:name,params})+"\n");}
const reader=Bun.stdin.stream().getReader();let pending="";const decoder=new TextDecoder();
while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value);while(pending.includes("\n")){const i=pending.indexOf("\n");const r=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(r.method==="runtime.initialize" || r.method==="account.initialize"){init=r.method==="account.initialize"?{botId:"account",sessionId:""}:r.params;writeFileSync(join(root,init.botId+".pid"),String(process.pid));send(r,{protocolVersion:11});continue;}
const auth=join(root,"shared.auth"),session=join(root,init.botId+".session");appendFileSync(join(root,init.botId+".trace"),r.method+" "+init.sessionId+"\n");
const byok=existsSync(auth)&&readFileSync(auth,"utf8")==="byok";
if(["session.bootstrap","session.resume"].includes(r.method) && init.model.startsWith("mochi-byok/")!==byok){reject(r,"model_policy_unavailable");continue;}
if(r.method==="account.read")send(r,existsSync(auth)?{status:"signedIn",account:byok?{provider:"mochi-byok",authType:"api_key",subscription:false,label:"Test",model:"mochi-byok/gpt-test"}:{provider:"openai-codex",authType:"oauth",subscription:true},connections:[byok?{provider:"mochi-byok",authType:"api_key",subscription:false,label:"Test",model:"mochi-byok/gpt-test"}:{provider:"openai-codex",authType:"oauth",subscription:true}]}:{status:"signedOut"});
else if(r.method==="model.list")send(r,[{id:byok?"mochi-byok/gpt-test":"gpt-test",displayName:"Test",description:"Test model",supportedEfforts:[{id:"high",description:"High"}],defaultEffort:"high"}]);
else if(r.method==="policy.update"){init.model=r.params.model;send(r,{});}
else if(r.method==="account.byok.configure"){writeFileSync(auth,"byok");send(r,{});event("account.updated",{status:"signedIn"});}
else if(r.method==="account.login.start"){login=crypto.randomUUID();send(r,{loginId:login,authorizationUrl:"https://auth.openai.com/fixture"});setTimeout(()=>{writeFileSync(auth,"connected");event("account.login.completed",{loginId:login,success:true});event("account.updated",{status:"signedIn"});},30);}
else if(r.method==="account.logout" || r.method==="account.byok.remove"){const {rmSync}=await import("node:fs");rmSync(auth,{force:true});send(r,{});}
else if(r.method==="session.bootstrap"){const deadline=Date.now()+3000;while(existsSync(join(root,init.botId+".hold-bootstrap"))){if(Date.now()>deadline)throw Error("bootstrap hold timeout");await Bun.sleep(10);}if(existsSync(session) && readFileSync(session,"utf8")!==init.sessionId)throw Error("wrong bootstrap identity");writeFileSync(session,init.sessionId);send(r,{sessionId:init.sessionId,capabilityAbi:init.capabilityAbi});}
else if(r.method==="session.resume"){if(existsSync(join(root,init.botId+".fail-resume")))throw Error("verification failed");if(readFileSync(session,"utf8")!==init.sessionId)throw Error("wrong session");send(r,{sessionId:init.sessionId,capabilityAbi:init.capabilityAbi});}
else if(r.method==="runtime.shutdown"){send(r,{});process.exit(0);}
else send(r,{});
}}
`;
