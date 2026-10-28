import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, type InlineConfig } from "vite";
import { rendererAttribution } from "./attribution.ts";

const root = resolve(import.meta.dir, "../..");

/** Production, native development and WebKit fixtures use the same renderer compiler. */
export async function rendererConfig(
  options: { fixture?: boolean; nonce?: string } = {},
): Promise<InlineConfig> {
  // Load the installed SDK's official alias adapter; never patch generated vendor sources.
  const { electrobunViteAliases } = (await import(
    resolve(root, ".hutch/devkit/api/config/electrobun-vite.ts")
  )) as {
    electrobunViteAliases(
      path: string,
    ): { find: RegExp; replacement: string }[];
  };
  return {
    configFile: false,
    root: join(root, "controlApp/src/ui"),
    envDir: false,
    cacheDir: join(
      root,
      "controlApp/.build/vite-cache",
      options.nonce ? "development" : "production",
    ),
    base: "./",
    publicDir: join(root, "controlApp/.build/public"),
    clearScreen: false,
    resolve: { alias: electrobunViteAliases(join(root, ".hutch/devkit")) },
    // CSS compilers expose original package sources here. Final build maps stay off.
    css: { devSourcemap: true },
    plugins: [
      tailwindcss(),
      react(),
      {
        name: "mochi-renderer-contract",
        transformIndexHtml: {
          order: "pre",
          handler(html) {
            if (options.fixture)
              html = html.replace(
                'src="/main.tsx"',
                `src="/@fs${join(root, "controlApp/tests/fixture.tsx")}"`,
              );
            if (options.fixture)
              html = html.replace(
                'src="/settings-main.tsx"',
                `src="/@fs${join(root, "controlApp/tests/settingsFixture.tsx")}"`,
              );
            if (options.nonce)
              html = html.replace(
                "script-src 'self' views:",
                `script-src 'self' views: 'nonce-${options.nonce}'`,
              );
            return html;
          },
        },
      },
      rendererAttribution((packages) => {
        if (!options.fixture)
          writeFileSync(
            join(root, "controlApp/.build/renderer-packages.json"),
            JSON.stringify(packages),
          );
      }),
    ],
    ...(options.nonce ? { html: { cspNonce: options.nonce } } : {}),
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      cors: false,
      fs: {
        strict: true,
        allow: [root],
        deny: [
          "**/.env*",
          "**/*.{crt,pem,key}",
          "**/.git/**",
          join(root, "config/**"),
          join(root, "dist/**"),
        ],
      },
    },
    build: {
      outDir: join(
        root,
        options.fixture
          ? "controlApp/.build/ui-fixture"
          : "controlApp/.build/views/main",
      ),
      emptyOutDir: true,
      target: "safari17",
      rolldownOptions: {
        input: {
          main: join(root, "controlApp/src/ui/index.html"),
          settings: join(root, "controlApp/src/ui/settings.html"),
        },
      },
      sourcemap: false,
    },
  };
}

export async function buildRenderer(fixture = false): Promise<void> {
  await build(await rendererConfig({ fixture }));
}
