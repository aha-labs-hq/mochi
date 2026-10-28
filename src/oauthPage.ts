/// <reference path="./runtime/assets.d.ts" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import characterFile from "../controlApp/Resources/MochiCompanion.png" with { type: "file" };
import feltFile from "./oauthFelt.webp" with { type: "file" };
import manifest from "../motion/manifest.json";

const character = manifest.characters.find((entry) => entry.id === manifest.defaultCharacter)!;
const root = character.assets.find((entry) => entry.id === character.rootAsset)!;
const pixels = readFileSync(characterFile);
if (root.source !== "controlApp/Resources/MochiCompanion.png"
  || createHash("sha256").update(pixels).digest("hex") !== root.sha256) {
  throw new Error("OAuth page artwork does not match the motion manifest root");
}
const image = `data:image/png;base64,${pixels.toString("base64")}`;
const felt = `data:image/webp;base64,${readFileSync(feltFile).toString("base64")}`;
const baseline = root.geometry.bodyBottom / root.geometry.canvasHeight * 100;
const browserScript = `
if (location.protocol === "http:" || location.protocol === "https:") {
  history.replaceState(null, "", location.pathname);
}
document.getElementById("close-page").addEventListener("click", () => {
  window.close();
  document.getElementById("close-help").hidden = false;
});`;
const scriptHash = createHash("sha256").update(browserScript).digest("base64");

/** Fixed, credential-free presentation. Receiving a code is not a saved account. */
export const oauthCallbackContentSecurityPolicy = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'`;

function renderCallbackPage(provider: "ChatGPT" | "GitHub", outcome: "received" | "rejected" | "installation"): string {
  const received = outcome === "received";
  const installation = outcome === "installation";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${oauthCallbackContentSecurityPolicy}">
  <title>${installation ? "返回 Mochi" : received ? "授权已收到" : "授权未完成"} · Mochi</title>
  <link rel="icon" href="${image}">
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; color: #313632; background: #fafbf9; font-synthesis: none; }
    * { box-sizing: border-box; letter-spacing: 0; }
    body { margin: 0; min-height: 100svh; display: grid; align-items: center; }
    main { width: min(100%, 480px); margin: auto; padding: 48px 24px 24px; text-align: center; }
    .portrait { position: relative; width: 176px; aspect-ratio: 1; margin: 0 auto 48px; }
    .portrait::before { content: ""; position: absolute; top: ${baseline}%; left: -16px; right: -16px; height: 12px; border-radius: 3px; background: #b7c8e3 url("${felt}") center / 208px; box-shadow: 0 2px 4px #0000000d; }
    .portrait img { position: relative; display: block; width: 100%; height: auto; }
    h1 { margin: 0; font-size: 26px; font-weight: 500; line-height: 1.5; text-wrap: balance; }
    .detail { margin: 12px 0 26px; font-size: 14px; color: #727871; line-height: 1.8; text-wrap: pretty; }
    button { min-height: 44px; padding: 10px 16px; border: 0; border-radius: 6px; background: transparent; color: #515c55; font: inherit; font-size: 13px; cursor: pointer; transition: background 120ms; }
    button:hover { background: #edf1eb; }
    button:focus-visible { outline: 2px solid #637a69; outline-offset: 3px; }
    .close-icon { display: inline-block; margin-left: 10px; font-size: 17px; font-weight: 400; vertical-align: -1px; }
    .help-slot { min-height: 40px; margin-top: 12px; }
    .help { margin: 0; font-size: 12px; line-height: 1.8; color: #727871; }
    @media (max-height: 600px) { main { padding-top: 24px; } .portrait { width: 144px; margin-bottom: 36px; } }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  </style>
</head>
<body>
  <main>
    <div class="portrait"><img src="${image}" width="${root.geometry.canvasWidth}" height="${root.geometry.canvasHeight}" alt="Mochi 的毛毡猫趴在边沿，等你回来"></div>
    <h1>${installation ? "可以回到 Mochi，查看可用项目了" : received ? `${provider} 授权已收到，可以回到 Mochi 了` : "这次没能完成授权"}</h1>
    <p class="detail">${installation ? "Mochi 会重新核对 GitHub 项目权限，这个页面可以关掉了。" : received ? (provider === "GitHub" ? "回到 Mochi 选择要连接的项目，这个页面可以关掉了。" : "Mochi 会完成连接并显示结果，这个页面可以关掉了。") : `回到 Mochi，重新登录 ${provider}。`}</p>
    <button id="close-page" type="button">关闭页面<span class="close-icon" aria-hidden="true">×</span></button>
    <div class="help-slot"><p id="close-help" class="help" role="status" hidden>也可以手动关闭标签页，再切回 Mochi。</p></div>
    <noscript><p class="help">请关闭这个标签页，回到 Mochi 继续。</p></noscript>
  </main>
  <script>${browserScript}</script>
</body>
</html>`;
}

export const chatGPTCallbackPages = {
  received: renderCallbackPage("ChatGPT", "received"),
  rejected: renderCallbackPage("ChatGPT", "rejected"),
};

export const githubCallbackPages = {
  installation: renderCallbackPage("GitHub", "installation"),
  received: renderCallbackPage("GitHub", "received"),
  rejected: renderCallbackPage("GitHub", "rejected"),
};
