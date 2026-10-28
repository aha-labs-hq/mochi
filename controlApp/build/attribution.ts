import type { Plugin } from "vite";

/** Package ownership from compiler paths, including nested/scoped installations.
 * Source maps may express these paths relative to the filesystem root. */
export function sourcePackage(source: string): string | null {
  const path = source.split("?")[0]!;
  const marker = "/node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const [first, second] = path.slice(index + marker.length).split("/");
  if (!first || (first.startsWith("@") && !second))
    throw new Error("Bundled source has no package attribution");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

/** JS comes from emitted chunks; CSS comes from the same compiler's source maps.
 * Inspect maps internally, never ship them or count build tools as app code. */
export function rendererAttribution(
  record: (packages: string[]) => void,
): Plugin {
  const stylesheets = new Map<string, readonly string[]>();
  return {
    name: "mochi-renderer-attribution",
    enforce: "post",
    buildStart() {
      stylesheets.clear();
    },
    transform(_code, id) {
      if (id.split("?")[0]!.endsWith(".css"))
        stylesheets.set(id, this.getCombinedSourcemap().sources);
    },
    generateBundle(_options, bundle) {
      const packages = new Set<string>();
      for (const entry of Object.values(bundle)) {
        if (entry.type !== "chunk") continue;
        for (const id of Object.keys(entry.modules)) {
          for (const source of [id, ...(stylesheets.get(id) ?? [])]) {
            const name = sourcePackage(source);
            if (name) packages.add(name);
          }
        }
      }
      record([...packages].sort());
    },
  };
}
