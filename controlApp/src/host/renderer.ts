/** Runtime input is accepted only by a compile-time development build. */
export function rendererURL(
  development: boolean,
  value: string | undefined,
): string {
  if (value === undefined) return "views://main/index.html";
  if (!development)
    throw new Error("Packaged Mochi cannot load a development server");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/index.html" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid Mochi development renderer origin");
  }
  return url.href;
}

/** Settings uses another compiled entry from the same validated local origin. */
export function settingsRendererURL(mainURL: string): string {
  const url = new URL(mainURL);
  url.pathname = url.pathname.replace(/index\.html$/, "settings.html");
  return url.href;
}
