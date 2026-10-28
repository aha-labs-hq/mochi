import { Component, type ReactNode } from "react";
import { reportRendererHealth } from "./health.ts";

export class RenderBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    reportRendererHealth("render-failed");
  }
  override render() {
    return this.state.failed ? <Unavailable /> : this.props.children;
  }
}

export function Unavailable() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-10 text-center text-ink [&>p]:leading-[1.8]">
      <h1>Mochi 暂时无法显示</h1>
      <p>这份 App 的界面或角色资源不完整。请重新打开或更新 Mochi。</p>
    </main>
  );
}
