import { expect, mock, test } from "bun:test";
import { initialSnapshot } from "../src/shared/model.ts";

// The native window, its RPC and the message box are Electrobun's; the close
// decision under test is Mochi's. Every `electrobun/*` entry resolves to the
// same installed file, so one fake serves them all.
const messages: { title: string; message: string }[] = [];
let handlers: { requests: { ready(): Promise<unknown> } } | null = null;
const electrobun = {
  showMessageBox: async (options: { title: string; message: string }) => {
    messages.push(options);
    return { response: 0 };
  },
  BrowserView: {
    defineRPC: (options: { handlers: typeof handlers }) => {
      handlers = options.handlers;
      return {
        send: { frame: () => {} },
        request: { closeState: async () => ({ dirty: false, busy: true }) },
      };
    },
  },
  BrowserWindow: class {
    id = 1;
    ptr = 1;
    webview = { on: () => {} };
    on() {}
    show() {}
    activate() {}
    close() {}
  },
};
for (const entry of ["utils", "browser-view", "browser-window"])
  mock.module(`electrobun/main/${entry}`, () => electrobun);
const { SettingsWindow } = await import("../src/host/settingsWindow.ts");

test("closing or quitting during an operation names the operation, not saving", async () => {
  const controller = {
    snapshot: initialSnapshot("0.3.0", true),
    subscribe: () => () => {},
    recheck: async () => {},
  };
  const settings = new SettingsWindow(
    controller as never,
    { configureSettingsWindow: () => {} } as never,
    "views://settings/index.html",
    () => {},
    () => {},
  );
  settings.show("settings");
  await handlers!.requests.ready();
  expect(await settings.approveClose("window")).toBe(false);
  expect(await settings.approveClose("quit")).toBe(false);
  expect(messages.map(({ title, message }) => `${title}：${message}`)).toEqual([
    "操作正在进行：当前操作结束后，再关闭设置。",
    "操作正在进行：当前操作结束后，再退出 Mochi。",
  ]);
});
