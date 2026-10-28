import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chatGPTCallbackPages, githubCallbackPages } from "../src/oauthPage.ts";

const output = resolve(import.meta.dir, "../artifacts/oauth-page");
await mkdir(output, { recursive: true });
for (const [name, html] of Object.entries({ ...chatGPTCallbackPages, "github-installation": githubCallbackPages.installation, "github-received": githubCallbackPages.received, "github-rejected": githubCallbackPages.rejected })) {
  const path = resolve(output, `${name}.html`);
  await writeFile(path, html);
  console.log(path);
}
