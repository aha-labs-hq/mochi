import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pictures } from "./build/pictures.ts";

// The website shares the companion's renderer toolchain: Vite, React and
// Tailwind. `build/site.ts` drives this config twice and prerenders the pages.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  publicDir: "public",
  plugins: [pictures(), react(), tailwind()],
  build: {
    assetsInlineLimit: 0,
    reportCompressedSize: false,
  },
});
