import { renderToString } from "react-dom/server";
import favicon48 from "../../controlApp/Resources/MochiAppIcon.png?w=48&png";
import favicon96 from "../../controlApp/Resources/MochiAppIcon.png?w=96&png";
import touchIcon from "../../controlApp/Resources/MochiAppIcon.png?w=180&png";
import icon192 from "../../controlApp/Resources/MochiAppIcon.png?w=192&png";
import icon512 from "../../controlApp/Resources/MochiAppIcon.png?w=512&png";
import { type SiteContext, SiteProvider } from "./context.ts";
import { pages } from "./pages.tsx";
import { pageHead } from "./seo.ts";

export { pages };

/** Written by `build/site.ts` beside the pages: 1200 × 630. */
export const SHARE_IMAGE = "/og.png";
/** Icons the build lists in the web manifest. */
export const manifestIcons = [
  { src: icon192, sizes: "192x192", type: "image/png" },
  { src: icon512, sizes: "512x512", type: "image/png" },
];

export function render(path: string, site: SiteContext) {
  const page = pages.find((item) => item.path === path);
  if (!page) throw new Error(`Unknown page ${path}`);
  const body = renderToString(
    <SiteProvider value={site}>
      <page.Page />
    </SiteProvider>,
  );
  return {
    head: pageHead(page, site, {
      favicon48,
      favicon96,
      touchIcon,
      shareImage: SHARE_IMAGE,
    }),
    body,
  };
}
