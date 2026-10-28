// Runs before the application module. Only fixed diagnostics cross this channel;
// browser error messages, document content and URLs are deliberately excluded.
type RendererHealth =
  | "module-starting"
  | "catalog-ready"
  | "motion-ready"
  | "surface-ready"
  | "render-failed"
  | "motion-failed";
export function reportRendererHealth(phase: RendererHealth): void {
  // Documented one-way host-message bridge; absent only in browser test fixtures.
  const bridge = window as Window & {
    __electrobunSendToHost?: (value: unknown) => void;
  };
  bridge.__electrobunSendToHost?.({ type: "renderer-health", phase });
}
