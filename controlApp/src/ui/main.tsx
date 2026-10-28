import { createRoot } from "react-dom/client";
import { MotionCatalog } from "../motion/catalog.ts";
import { App } from "./App.tsx";
import { connect } from "./connection.ts";
import "./style.css";
import manifest from "../../../motion/manifest.json";
import { reportRendererHealth } from "./health.ts";
import { RenderBoundary, Unavailable } from "./RenderBoundary.tsx";

// This entry owns one React root; component-only modules own Fast Refresh.
const root = createRoot(document.getElementById("root")!);
try {
  reportRendererHealth("module-starting");
  const catalog = new MotionCatalog(manifest);
  reportRendererHealth("catalog-ready");
  root.render(
    <RenderBoundary>
      <App connection={connect()} catalog={catalog} />
    </RenderBoundary>,
  );
} catch {
  reportRendererHealth("render-failed");
  root.render(<Unavailable />);
}
