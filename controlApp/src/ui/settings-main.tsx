import { createRoot } from "react-dom/client";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { SettingsApp } from "./SettingsApp.tsx";
import { connectSettings } from "./settingsConnection.ts";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <RenderBoundary>
    <SettingsApp connection={connectSettings()} />
  </RenderBoundary>,
);
