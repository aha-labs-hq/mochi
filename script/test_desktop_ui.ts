import { join, resolve } from "node:path";
import { prepareResources } from "../controlApp/build/resources.ts";
import { buildRenderer } from "../controlApp/build/vite.ts";
import {
  chatGPTCallbackPages,
  githubCallbackPages,
  oauthCallbackContentSecurityPolicy,
} from "../src/oauthPage.ts";

const root = resolve(import.meta.dir, ".."),
  output = join(root, "controlApp/.build/ui-fixture");
// A fixture must use this manifest's pixels, even when the previous native build
// used different artwork under the same canonical resource names.
await prepareResources(root, join(root, "controlApp/.build"), async (args) => {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) throw new Error(`Fixture resources: ${stderr}`);
  return stdout;
});
await buildRenderer(true);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (
      /^\/oauth\/(github\/)?(received|rejected)$/.test(path) ||
      path === "/oauth/github/installation"
    ) {
      return new Response(
        path === "/oauth/github/installation"
          ? githubCallbackPages.installation
          : (path.startsWith("/oauth/github/")
              ? githubCallbackPages
              : chatGPTCallbackPages)[
              path.endsWith("/received") ? "received" : "rejected"
            ],
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": `${oauthCallbackContentSecurityPolicy}; frame-ancestors 'none'`,
          },
        },
      );
    }
    const relative = path.replace(/^\/main\//, "");
    const base = output;
    const filePath = resolve(base, relative);
    if (!filePath.startsWith(`${base}/`))
      return new Response("Not found", { status: 404 });
    return new Response(Bun.file(filePath));
  },
});
try {
  const child = Bun.spawn(
    [
      join(root, "node_modules/.bin/playwright"),
      "test",
      "--config",
      "controlApp/playwright.config.ts",
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MOCHI_UI_TEST_URL: `http://127.0.0.1:${server.port}`,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0)
    throw new Error("Desktop WebKit tests failed");
} finally {
  await server.stop(true);
}
