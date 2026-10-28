import { expect, test } from "bun:test";
import { DesktopPresentation } from "../src/host/presentation.ts";
import { rendererURL } from "../src/host/renderer.ts";
import {
  type DesktopFrame,
  type DesktopSnapshot,
  initialSnapshot,
} from "../src/shared/model.ts";
import { problem, reconcileActionProblem } from "../src/shared/problem.ts";
import type { Connection } from "../src/ui/connection.ts";
import {
  createDesktopQueries,
  modelCatalogQuery,
  QueryProblem,
} from "../src/ui/queries.ts";
import { createDesktopStore, observeDesktop } from "../src/ui/store.ts";

function connection() {
  const pending = Promise.withResolvers<void>();
  const listeners = new Set<(frame: DesktopFrame) => void>();
  const value: Connection = {
    closeWindow: () => {},
    ready: () => pending.promise,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    perform: async () => ({ ok: true, value: null }),
    models: async () => ({ ok: true, value: [] }),
    schedules: async () => ({ ok: true, value: [] }),
    skills: async () => ({ ok: true, value: [] }),
    instructions: async () => ({
      ok: true,
      value: { content: "test", revision: "a".repeat(64) },
    }),
    endPreview: async () => {},
    previewExperience: async () => {},
    showSettings: async () => {},
    present: async () => {},
    presentationPainted: async () => {},
  };
  return { value, pending, listeners };
}
test("readiness cannot overwrite pushed facts; cleanup rejects late delivery", async () => {
  const link = connection(),
    store = createDesktopStore();
  const stop = observeDesktop(store, link.value);
  const pushed = {
    ...initialSnapshot("0.2.0", true),
    phase: "working" as const,
  };
  for (const listener of link.listeners)
    listener({ snapshot: pushed, preview: null, surface: "companion" });
  link.pending.resolve();
  await link.pending.promise;
  expect(store.getState().snapshot).toBe(pushed);
  const queued = [...link.listeners][0]!;
  stop();
  expect(link.listeners.size).toBe(0);
  queued({
    snapshot: initialSnapshot("late-event", false),
    preview: null,
    surface: "companion",
  });
  expect(store.getState().snapshot).toBe(pushed);
  const next = connection();
  observeDesktop(store, next.value)();
  next.pending.reject(new Error("late failure"));
  await next.pending.promise.catch(() => {});
  expect(store.getState().snapshot).toBe(pushed);
  expect(store.getState().connectionProblem).toBeNull();
});
test("a recovered connection clears only its own error, not a failed action", async () => {
  const link = connection(),
    store = createDesktopStore();
  const stop = observeDesktop(store, link.value);
  link.pending.reject(new Error("not ready"));
  await link.pending.promise.catch(() => {});
  expect(store.getState().connectionProblem?.code).toBe("control_unavailable");
  const actionProblem = problem("control_response_invalid");
  store.setState({ actionProblem });
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    phase: "listening" as const,
  };
  for (const listener of link.listeners)
    listener({ snapshot, preview: null, surface: "companion" });
  expect(store.getState()).toMatchObject({
    snapshot,
    connectionProblem: null,
    actionProblem,
  });
  stop();
});
test("serialized action contention stays out of user-facing errors", () => {
  expect(
    reconcileActionProblem(
      problem("action_in_progress"),
      initialSnapshot("0.2.0", true),
    ),
  ).toBeNull();
});
test("only verified duty clears a readiness timeout, and it stays cleared", () => {
  const link = connection(),
    store = createDesktopStore();
  const stop = observeDesktop(store, link.value);
  const healthy: DesktopSnapshot = {
    ...initialSnapshot("0.2.0", true),
    installed: true,
    loaded: true,
    controlReady: true,
    eventStreamReady: true,
    phase: "listening",
  };
  const push = (snapshot: DesktopSnapshot) => {
    for (const listener of link.listeners)
      listener({ snapshot, preview: null, surface: "companion" });
  };
  store.setState({ actionProblem: problem("service_readiness_timeout") });
  for (const patch of [
    { installed: false },
    { loaded: false },
    { controlReady: false },
    { eventStreamReady: false },
    { phase: "attention" as const },
    { problem: problem("service_identity_mismatch") },
  ]) {
    push({ ...healthy, ...patch });
    expect(store.getState().actionProblem?.code).toBe(
      "service_readiness_timeout",
    );
  }
  push(healthy);
  expect(store.getState().actionProblem).toBeNull();
  push({ ...healthy, phase: "attention", eventStreamReady: false });
  expect(store.getState().actionProblem).toBeNull();
  stop();
});
test("window surface follows its host authority, independently of setup observations", () => {
  const link = connection(),
    store = createDesktopStore();
  const stop = observeDesktop(store, link.value);
  const snapshot = initialSnapshot("0.2.0", true);
  const push = (surface: "setup" | "companion") => {
    for (const listener of link.listeners)
      listener({ snapshot, preview: null, surface });
  };
  push("setup");
  expect(store.getState().surface).toBe("setup");
  push("companion");
  expect(store.getState().surface).toBe("companion");
  expect(createDesktopStore().getState().surface).toBe("companion");
  stop();
});
test("a frame proves readiness even if the readiness response fails later", async () => {
  const link = connection(),
    store = createDesktopStore();
  const stop = observeDesktop(store, link.value);
  for (const listener of link.listeners)
    listener({
      snapshot: initialSnapshot("0.2.0", true),
      preview: null,
      surface: "companion",
    });
  link.pending.reject(new Error("late response failure"));
  await link.pending.promise.catch(() => {});
  expect(store.getState().connectionProblem).toBeNull();
  stop();
});
test("first companion subscription receives signed-in facts without settings state", () => {
  const snapshot = {
    ...initialSnapshot("0.2.0", true),
    account: {
      status: "signedIn" as const,
      account: {
        provider: "openai-codex" as const,
        authType: "oauth" as const,
        subscription: true as const,
      },
      connections: [
        {
          provider: "openai-codex" as const,
          authType: "oauth" as const,
          subscription: true as const,
        },
      ],
    },
  };
  const presentation = new DesktopPresentation(() => snapshot);
  const link = connection(),
    store = createDesktopStore();
  const renderer = presentation.attach((frame) => {
    for (const listener of link.listeners) listener(frame);
  });
  link.value.ready = async () => renderer.ready();
  const stop = observeDesktop(store, link.value);
  expect(store.getState()).toMatchObject({ snapshot });
  presentation.publish();
  stop();
  renderer.close();
});
test("model queries surface the safe domain failure once, without retries", async () => {
  const link = connection(),
    queries = createDesktopQueries();
  let calls = 0;
  link.value.models = async () => {
    calls++;
    return { ok: false, problem: problem("control_unavailable") };
  };
  await expect(
    queries.fetchQuery(
      modelCatalogQuery(link.value, "11111111-2222-4333-8444-555555555555"),
    ),
  ).rejects.toBeInstanceOf(QueryProblem);
  expect(calls).toBe(1);
  expect(queries.getDefaultOptions().queries).toMatchObject({
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  });
  queries.clear();
});
test("only a development build accepts a precise local renderer", () => {
  expect(rendererURL(false, undefined)).toBe("views://main/index.html");
  expect(rendererURL(true, "http://127.0.0.1:5173/index.html")).toBe(
    "http://127.0.0.1:5173/index.html",
  );
  for (const url of [
    "http://127.0.0.1:5173/index.html",
    "https://evil.example",
    "http://localhost:5173/index.html",
    "http://127.0.0.1:5173/index.html?x=1",
    "http://user@127.0.0.1:5173/index.html",
  ]) {
    expect(() => rendererURL(false, url)).toThrow();
    if (url !== "http://127.0.0.1:5173/index.html")
      expect(() => rendererURL(true, url)).toThrow();
  }
});
