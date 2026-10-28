/**
 * Serves `site/dist` locally, the way Pages resolves its pages and applies
 * its `_headers`, so the content security policy is exercised before deploy.
 */
import { join, normalize, resolve } from "node:path";
import { headersFor, parseHeaders } from "./headers.ts";

const dist = resolve(import.meta.dir, "../dist");
const port = Number(process.env.PORT ?? 4321);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const path = normalize(decodeURIComponent(url.pathname));
    if (path.includes(".."))
      return new Response("Bad request", { status: 400 });
    const headers = headersFor(
      parseHeaders(await Bun.file(join(dist, "_headers")).text()),
      url,
    );
    const file = Bun.file(
      join(dist, path.endsWith("/") ? `${path}index.html` : path),
    );
    if (await file.exists()) return new Response(file, { headers });
    if (await Bun.file(join(dist, path, "index.html")).exists())
      return Response.redirect(`${path}/`, 308);
    return new Response(Bun.file(join(dist, "404.html")), {
      status: 404,
      headers,
    });
  },
});
console.log(`Website at ${server.url}`);
