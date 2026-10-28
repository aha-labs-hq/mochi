import {
  CString,
  dlopen,
  FFIType,
  JSCallback,
  type Pointer,
  ptr,
} from "bun:ffi";
import { join } from "node:path";
import type { ByokConnectionInput } from "../../../src/runtime/byok.ts";
import type { DesktopSurface } from "../shared/experience.ts";
import { planWindow, type WindowRect } from "../shared/windowHandoff.ts";
import type { ByokPromptInitial, ByokPromptProblem } from "./byokPrompt.ts";
import {
  type MenuBarAction,
  type MenuBarState,
  parseMenuBarAction,
} from "./menuBar.ts";
import type { WindowStagePlan } from "./windowHandoff.ts";

const surfaceCode = (surface: DesktopSurface | null) =>
  surface === null
    ? -1
    : { intro: 0, setup: 1, companion: 2, encounter: 3 }[surface];

/** App-lifetime native ABI. No credentials, control commands or lifecycle policy. */
export function appKit(resources: string) {
  const library = dlopen(join(resources, "libMochiAppKit.dylib"), {
    mochi_prepare_webviews: { args: [], returns: FFIType.i32 },
    mochi_choose_uninstall: { args: [FFIType.ptr], returns: FFIType.void },
    mochi_authorize_setup: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_background_status: { args: [FFIType.ptr], returns: FFIType.i32 },
    mochi_open_login_items: { args: [], returns: FFIType.void },
    mochi_configure_window: { args: [FFIType.ptr], returns: FFIType.void },
    mochi_configure_settings_window: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_has_finished_setup: { args: [], returns: FFIType.i32 },
    mochi_remember_finished_setup: { args: [], returns: FFIType.void },
    mochi_has_met: { args: [], returns: FFIType.i32 },
    mochi_remember_meeting: { args: [], returns: FFIType.void },
    mochi_plan_window: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_place_window: {
      args: [
        FFIType.ptr,
        FFIType.f64,
        FFIType.f64,
        FFIType.f64,
        FFIType.f64,
        FFIType.i32,
        FFIType.ptr,
      ],
      returns: FFIType.void,
    },
    mochi_save_diagnostics: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_confirm: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_prompt_byok: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.void,
    },
    mochi_finish_byok_attempt: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.void,
    },
    mochi_create_menu_bar: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    },
    mochi_update_menu_bar: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  if (library.symbols.mochi_prepare_webviews() !== 1)
    throw new Error("Native webview contract unavailable");
  // The status item and its callback live exactly as long as this App process.
  let menuAction: JSCallback | null = null;
  const kit = {
    async chooseUninstall(): Promise<"keepData" | "deleteAll" | null> {
      const result = Promise.withResolvers<"keepData" | "deleteAll" | null>();
      const completion = new JSCallback(
        (value: number) => {
          if (value === 0) result.resolve(null);
          else if (value === 1 || value === 2)
            result.resolve(value === 1 ? "keepData" : "deleteAll");
          else result.reject(new Error("Uninstall confirmation unavailable"));
        },
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      try {
        library.symbols.mochi_choose_uninstall(completion.ptr);
        return await result.promise;
      } finally {
        completion.close();
      }
    },
    async authorizeSetup(script: string): Promise<number> {
      const result = Promise.withResolvers<number>();
      const completion = new JSCallback(
        (status: number) => result.resolve(status),
        {
          args: [FFIType.i32],
          returns: FFIType.void,
          threadsafe: true,
        },
      );
      const source = Buffer.from(`${script}\0`, "utf8");
      try {
        library.symbols.mochi_authorize_setup(ptr(source), completion.ptr);
        return await result.promise;
      } finally {
        completion.close();
      }
    },
    backgroundStatus(plistPath: string): number {
      const path = Buffer.from(`${plistPath}\0`, "utf8");
      return library.symbols.mochi_background_status(ptr(path));
    },
    openLoginItems(): void {
      library.symbols.mochi_open_login_items();
    },
    async createMenuBar(
      initial: MenuBarState,
      onAction: (action: MenuBarAction) => void,
    ) {
      if (menuAction) throw new Error("Menu bar already created");
      menuAction = new JSCallback(
        (value: Pointer) =>
          onAction(parseMenuBarAction(new CString(value).toString())),
        { args: [FFIType.ptr], returns: FFIType.void, threadsafe: true },
      );
      const ready = Promise.withResolvers<void>();
      const completion = new JSCallback(
        (status: number) =>
          status === 0
            ? ready.resolve()
            : ready.reject(new Error("Native menu unavailable")),
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      const icon = Buffer.from(`${join(resources, "Mochi.icns")}\0`, "utf8");
      let previous = JSON.stringify(initial);
      const initialState = Buffer.from(`${previous}\0`, "utf8");
      try {
        library.symbols.mochi_create_menu_bar(
          ptr(icon),
          ptr(initialState),
          menuAction.ptr,
          completion.ptr,
        );
        await ready.promise;
      } finally {
        completion.close();
      }
      return {
        update(state: MenuBarState): void {
          const serialized = JSON.stringify(state);
          if (previous === serialized) return;
          previous = serialized;
          const json = Buffer.from(`${serialized}\0`, "utf8");
          library.symbols.mochi_update_menu_bar(ptr(json));
        },
      };
    },
    hasFinishedSetup(): boolean {
      return library.symbols.mochi_has_finished_setup() === 1;
    },
    rememberFinishedSetup(): void {
      library.symbols.mochi_remember_finished_setup();
    },
    hasMet(): boolean {
      return library.symbols.mochi_has_met() === 1;
    },
    rememberMeeting(): void {
      library.symbols.mochi_remember_meeting();
    },
    async planWindow(
      pointer: Pointer,
      surface: DesktopSurface,
    ): Promise<WindowStagePlan> {
      const result = Promise.withResolvers<WindowStagePlan>();
      const callback = new JSCallback(
        (
          status: number,
          x: number,
          y: number,
          width: number,
          height: number,
          tx: number,
          ty: number,
          tw: number,
          th: number,
          visible: number,
        ) => {
          if (status < 0 || (visible !== 0 && visible !== 1))
            result.reject(new Error("Presentation window unavailable"));
          else {
            try {
              result.resolve({
                ...planWindow(
                  { x, y, width, height },
                  { x: tx, y: ty, width: tw, height: th },
                ),
                visible: visible === 1,
              });
            } catch (error) {
              result.reject(error);
            }
          }
        },
        {
          args: [FFIType.i32, ...Array(8).fill(FFIType.f64), FFIType.i32],
          returns: FFIType.void,
          threadsafe: true,
        },
      );
      try {
        library.symbols.mochi_plan_window(
          pointer,
          surfaceCode(surface),
          callback.ptr,
        );
        return await result.promise;
      } finally {
        callback.close();
      }
    },
    async presentWindow(
      pointer: Pointer,
      surface: DesktopSurface,
    ): Promise<void> {
      const plan = await kit.planWindow(pointer, surface);
      await kit.placeWindow(pointer, plan.target, surface);
    },
    async placeWindow(
      pointer: Pointer,
      rect: WindowRect,
      surface: DesktopSurface | null,
    ): Promise<void> {
      const result = Promise.withResolvers<void>();
      const callback = new JSCallback(
        (status: number) => {
          if (status < 0)
            result.reject(new Error("Presentation window unavailable"));
          else result.resolve();
        },
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      try {
        library.symbols.mochi_place_window(
          pointer,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          surfaceCode(surface),
          callback.ptr,
        );
        await result.promise;
      } finally {
        callback.close();
      }
    },
    configureWindow(pointer: Pointer): void {
      library.symbols.mochi_configure_window(pointer);
    },
    configureSettingsWindow(pointer: Pointer): void {
      library.symbols.mochi_configure_settings_window(pointer);
    },
    async chooseDiagnosticsDestination(): Promise<string | null> {
      const destination = Buffer.alloc(4096);
      const result = Promise.withResolvers<string | null>();
      const callback = new JSCallback(
        (status: number) => {
          if (status === 0) result.resolve(null);
          else if (status === 1)
            result.resolve(
              destination.subarray(0, destination.indexOf(0)).toString("utf8"),
            );
          else result.reject(new Error("Diagnostics save panel unavailable"));
        },
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      try {
        library.symbols.mochi_save_diagnostics(
          ptr(destination),
          destination.byteLength,
          callback.ptr,
        );
        return await result.promise;
      } finally {
        callback.close();
      }
    },
    async confirm(
      title: string,
      message: string,
      accept: string,
    ): Promise<boolean> {
      const strings = [title, message, accept].map((text) =>
        Buffer.from(`${text}\0`, "utf8"),
      );
      const result = Promise.withResolvers<boolean>();
      const callback = new JSCallback(
        (accepted: number) => {
          if (accepted < 0)
            result.reject(new Error("Confirmation window unavailable"));
          else result.resolve(accepted === 1);
        },
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      try {
        library.symbols.mochi_confirm(
          ptr(strings[0]!),
          ptr(strings[1]!),
          ptr(strings[2]!),
          callback.ptr,
        );
        return await result.promise;
      } finally {
        callback.close();
      }
    },
    async promptByok(
      submit: (input: ByokConnectionInput) => Promise<ByokPromptProblem | null>,
      initial?: ByokPromptInitial,
    ): Promise<void> {
      const baseUrl = Buffer.alloc(8_193),
        model = Buffer.alloc(469),
        label = Buffer.alloc(481),
        apiKey = Buffer.alloc(4_097);
      const seed = (destination: Buffer, value: string | undefined) => {
        if (!value) return;
        const encoded = Buffer.from(`${value}\0`, "utf8");
        if (encoded.byteLength <= destination.byteLength)
          encoded.copy(destination);
      };
      seed(baseUrl, initial?.baseUrl);
      seed(model, initial?.model);
      seed(label, initial?.label);
      const result = Promise.withResolvers<void>();
      let failure: unknown;
      const finish = (feedback: ByokPromptProblem | null, fatal = false) => {
        const message = Buffer.from(`${feedback?.message ?? ""}\0`);
        const field = feedback?.field;
        library.symbols.mochi_finish_byok_attempt(
          ptr(message),
          field ? ["baseUrl", "model", "label", "apiKey"].indexOf(field) : -1,
          fatal ? -1 : feedback ? 0 : 1,
        );
      };
      const completion = new JSCallback(
        (status: number) => {
          if (status === 1) {
            const text = (value: Buffer) =>
              value.subarray(0, value.indexOf(0)).toString("utf8");
            const input = {
              baseUrl: text(baseUrl),
              model: text(model),
              label: text(label),
              apiKey: text(apiKey),
            };
            apiKey.fill(0);
            void Promise.resolve()
              .then(() => submit(input))
              .then(
                (feedback) => finish(feedback),
                (error) => {
                  failure = error;
                  finish(null, true);
                },
              );
          } else if (failure !== undefined) result.reject(failure);
          else if (status === 0 || status === 2) result.resolve();
          else result.reject(new Error("BYOK input unavailable"));
        },
        { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
      );
      try {
        library.symbols.mochi_prompt_byok(
          ptr(baseUrl),
          baseUrl.byteLength,
          ptr(model),
          model.byteLength,
          ptr(label),
          label.byteLength,
          ptr(apiKey),
          apiKey.byteLength,
          completion.ptr,
        );
        await result.promise;
      } finally {
        baseUrl.fill(0);
        model.fill(0);
        label.fill(0);
        apiKey.fill(0);
        completion.close();
      }
    },
  };
  return kit;
}
export type AppKit = ReturnType<typeof appKit>;
