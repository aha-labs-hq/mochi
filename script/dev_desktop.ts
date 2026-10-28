import { createServer } from "vite";
import { rendererConfig } from "../controlApp/build/vite.ts";
import {
  buildDesktop,
  launchDesktop,
  preserveDuty,
  stopDesktop,
  verifyDesktop,
} from "./build_desktop.ts";

// The launcher owns the server and exact development App as one lifetime. Duty
// is the user's: whatever was on duty before the App was replaced stays on.
const restoreDuty = preserveDuty();
let application: string;
try {
  application = await buildDesktop(false);
} catch (error) {
  await restoreDuty();
  throw error;
}
// Vite's production build sets NODE_ENV in this process. The subsequent server
// must explicitly enter development mode so React Fast Refresh remains enabled.
process.env.NODE_ENV = "development";
const server = await createServer(
  await rendererConfig({ nonce: crypto.randomUUID() }),
);
let stopping: Promise<void> | undefined;
function stop() {
  stopping ??= (async () => {
    await stopDesktop(application);
    await server.close();
    await restoreDuty();
  })();
  return stopping;
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
try {
  await server.listen();
  const origin = server.resolvedUrls?.local[0];
  if (!origin) throw new Error("Vite did not publish its loopback origin");
  const started = Date.now();
  const child = await launchDesktop(
    application,
    new URL("index.html", origin).href,
  );
  server.httpServer?.once("close", () => {
    void stop();
  });
  await verifyDesktop(application, started, child);
  await restoreDuty();
  console.log(
    "Mochi Development ready. React/CSS edits hot-reload; Ctrl-C closes this development App only.",
  );
  await child.exited;
} finally {
  await stop();
}
