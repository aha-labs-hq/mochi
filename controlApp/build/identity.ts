export function desktopIdentity(buildOnly: boolean) {
  return buildOnly
    ? { name: "Mochi", identifier: "app.mochi.companion" }
    : {
        name: "Mochi Development",
        identifier: "app.mochi.companion.development",
      };
}
