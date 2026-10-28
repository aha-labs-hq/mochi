import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeishuRegisteredApp, parseFeishuRegistrationUrl, registerFeishuApp } from "../src/lark/registration.ts";

const URL = "https://open.feishu.cn/page/cli?user_code=ABCD-EFGH&lpv=1.0.93&ocv=1.0.93&from=cli";
const RESULT = { appId: "cli_fixture", appSecret: "****", brand: "feishu" };
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

function fixture(body: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mochi-registration-test-")));
  directories.push(directory);
  const stageDirectory = join(directory, "stage");
  mkdirSync(stageDirectory, { mode: 0o700 });
  const cliPath = join(directory, "fake-lark.ts");
  writeFileSync(cliPath, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { cliPath, stageDirectory, signal: new AbortController().signal, onVerificationUrl: (_url: string) => undefined };
}
const validOutput = `process.stderr.write(${JSON.stringify(`  ${URL}\n`)}); process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))});`;

describe("official Feishu registration transport", () => {
  test("decodes only the exact provider URL, preserving it as an opaque value", () => {
    expect(parseFeishuRegistrationUrl(`  ${URL}\r`)).toBe(URL);
    const international = URL.replace("open.feishu.cn", "open.larksuite.com");
    expect(parseFeishuRegistrationUrl(international)).toBe(international);
    for (const line of ["", "等待扫码", "██ ▄▄ ██", `请打开 ${URL}`]) expect(parseFeishuRegistrationUrl(line)).toBeUndefined();
    for (const url of [
      URL.replace("open.feishu.cn", "open.feishu.cn.evil.example"),
      URL.replace("open.feishu.cn", "user@open.feishu.cn"), URL.replace("/page/cli", "/page/other"),
      `${URL}#x`, `${URL}&user_code=ABCD-EFGH`, `${URL}&name=Mochi`,
      URL.replace("ABCD-EFGH", "abcd"), URL.replace("ocv=1.0.93", "ocv=1.0.92"),
      URL.replace("from=cli", "from=other"), `https://${"x".repeat(2048)}`,
    ]) expect(() => parseFeishuRegistrationUrl(url)).toThrow("registration_output_invalid");
  });

  test("terminal handoff accepts masked output, not secrets or ordinary API envelopes", () => {
    expect(parseFeishuRegisteredApp(RESULT)).toEqual({ appId: RESULT.appId, brand: "feishu", profile: "mochi" });
    expect(parseFeishuRegisteredApp({ ...RESULT, brand: "lark" })).toEqual({ appId: RESULT.appId, brand: "lark", profile: "mochi" });
    for (const value of [null, [], {}, { ok: true, data: RESULT }, { ...RESULT, appSecret: "unmasked-secret" },
      { ...RESULT, brand: "unknown" }, { ...RESULT, appId: "wrong" }, { ...RESULT, extra: true }]) {
      expect(() => parseFeishuRegisteredApp(value)).toThrow("registration_output_invalid");
    }
  });

  test("uses an isolated official profile, bounded environment and no interactive stdin", async () => {
    const options = fixture(`
      import {writeFileSync} from "node:fs";
      const stage = process.env.LARKSUITE_CLI_CONFIG_DIR!;
      writeFileSync(stage + "/invocation.json", JSON.stringify({
        args: process.argv.slice(2), cwd: process.cwd(), stage, home: process.env.HOME,
        secret: process.env.MOCHI_REGISTRATION_TEST_SECRET,
        stdin: await new Response(Bun.stdin.stream()).text(),
      }));
      ${validOutput}
    `);
    const urls: string[] = [];
    const previous = process.env.MOCHI_REGISTRATION_TEST_SECRET;
    process.env.MOCHI_REGISTRATION_TEST_SECRET = "must-not-reach-child";
    try {
      expect(await registerFeishuApp({ ...options, onVerificationUrl: (url) => { urls.push(url); } }))
        .toEqual({ appId: RESULT.appId, brand: "feishu", profile: "mochi" });
    } finally {
      if (previous === undefined) delete process.env.MOCHI_REGISTRATION_TEST_SECRET;
      else process.env.MOCHI_REGISTRATION_TEST_SECRET = previous;
    }
    expect(urls).toEqual([URL]);
    expect(JSON.parse(readFileSync(join(options.stageDirectory, "invocation.json"), "utf8"))).toEqual({
      args: ["config", "init", "--new", "--name", "mochi", "--brand", "feishu", "--lang", "zh"],
      cwd: realpathSync("/var/empty"), stage: options.stageDirectory, home: options.stageDirectory, stdin: "",
    });
    expect(lstatSync(join(options.stageDirectory, ".registration-started")).mode & 0o777).toBe(0o600);
  });

  test("decodes split UTF-8 and URL chunks, delivering one attempt only once", async () => {
    const options = fixture(`
      const text = new TextEncoder().encode(${JSON.stringify(`等待扫码\n  ${URL}\n${URL}\n`)});
      for (const byte of text) { process.stderr.write(new Uint8Array([byte])); await Bun.sleep(1); }
      process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))});
    `);
    const urls: string[] = [];
    await registerFeishuApp({ ...options, onVerificationUrl: (url) => { urls.push(url); } });
    expect(urls).toEqual([URL]);
  });

  test("rejects switching the authorization attempt after showing a QR", async () => {
    const options = fixture(`${validOutput}
      process.stderr.write(${JSON.stringify(`${URL.replace("ABCD-EFGH", "WXYZ-1234")}\n`)});
    `);
    await expect(registerFeishuApp(options)).rejects.toThrow("registration_output_invalid");
  });

  test("does not interpret app creation as success after CLI post-save verification fails", async () => {
    const options = fixture(`
      import {writeFileSync} from "node:fs";
      writeFileSync(process.env.LARKSUITE_CLI_CONFIG_DIR + "/config.json", "fixture-saved-profile");
      ${validOutput}
      process.stderr.write("provider diagnostic must not enter UI");
      process.exitCode = 1;
    `);
    await expect(registerFeishuApp(options)).rejects.toThrow("registration_failed");
    expect(readFileSync(join(options.stageDirectory, "config.json"), "utf8")).toBe("fixture-saved-profile");
    await expect(registerFeishuApp(options)).rejects.toThrow("registration_stage_invalid");
  });

  test("cancellation stops a waiting CLI, retains the claimed stage and does not recreate", async () => {
    const options = fixture(`process.stderr.write(${JSON.stringify(`${URL}\n`)}); await new Promise(() => undefined);`);
    const controller = new AbortController();
    const urls: string[] = [];
    await expect(registerFeishuApp({ ...options, signal: controller.signal, onVerificationUrl: (url) => {
      urls.push(url); controller.abort();
    } })).rejects.toThrow("registration_cancelled");
    expect(urls).toEqual([URL]);
    expect(existsSync(join(options.stageDirectory, ".registration-started"))).toBe(true);
    await expect(registerFeishuApp(options)).rejects.toThrow("registration_stage_invalid");
  });

  test("an already canceled request never starts or claims the stage", async () => {
    const options = fixture(validOutput);
    await expect(registerFeishuApp({ ...options, signal: AbortSignal.abort() })).rejects.toThrow("registration_cancelled");
    expect(existsSync(join(options.stageDirectory, ".registration-started"))).toBe(false);
  });

  test("rejects concurrent reuse before either CLI persists a profile", async () => {
    const options = fixture(`process.stderr.write(${JSON.stringify(`${URL}\n`)}); await new Promise(() => undefined);`);
    const controller = new AbortController();
    let shown!: () => void;
    const shownPromise = new Promise<void>((resolve) => { shown = resolve; });
    const first = registerFeishuApp({ ...options, signal: controller.signal, onVerificationUrl: () => { shown(); } });
    const firstOutcome = first.then(() => undefined, (error: unknown) => error);
    try {
      await shownPromise;
      await expect(registerFeishuApp(options)).rejects.toThrow("registration_stage_invalid");
    } finally { controller.abort(); }
    expect(await firstOutcome).toMatchObject({ code: "registration_cancelled" });
  });

  test("rejects unsafe or nonempty staging instead of overwriting any profile", async () => {
    const options = fixture(validOutput);
    writeFileSync(join(options.stageDirectory, "existing-profile"), "preserve");
    await expect(registerFeishuApp(options)).rejects.toThrow("registration_stage_invalid");
    expect(readFileSync(join(options.stageDirectory, "existing-profile"), "utf8")).toBe("preserve");
    const other = fixture(validOutput);
    chmodSync(other.stageDirectory, 0o755);
    await expect(registerFeishuApp(other)).rejects.toThrow("registration_stage_invalid");
    const link = join(directories.at(-1)!, "link");
    symlinkSync(other.stageDirectory, link);
    await expect(registerFeishuApp({ ...other, stageDirectory: link })).rejects.toThrow("registration_stage_invalid");
  });

  test("closes over missing executables and never exposes a host path", async () => {
    const options = fixture("");
    await expect(registerFeishuApp({ ...options, cliPath: "/no-such-registration-cli" })).rejects.toThrow("registration_failed");
  });

  test("rejects malformed output, missing QR, overflow and unmasked terminal credentials", async () => {
    for (const body of [
      `process.stdout.write(${JSON.stringify(JSON.stringify(RESULT))});`,
      `process.stderr.write(${JSON.stringify(`${URL}\n`)}); process.stdout.write("not-json");`,
      `${validOutput} process.stderr.write(new Uint8Array([0xff]));`,
      `${validOutput} process.stderr.write("x".repeat(65_537));`,
      `${validOutput} process.stdout.write("x".repeat(65_537));`,
      `process.stderr.write(${JSON.stringify(`${URL}\n`)}); process.stdout.write(${JSON.stringify(JSON.stringify({ ...RESULT, appSecret: "unmasked-fixture" }))});`,
    ]) await expect(registerFeishuApp(fixture(body))).rejects.toThrow("registration_output_invalid");
  });
});
