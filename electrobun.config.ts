import type { ElectrobunConfig } from "electrobun";
import { desktopIdentity } from "./controlApp/build/identity.ts";
import { packageTrustFromEnvironment } from "./controlApp/build/packageTrust.ts";
import metadata from "./package.json";

export default {
  app: {
    ...desktopIdentity(process.env.MOCHI_DESKTOP_DEVELOPMENT !== "1"),
    version: metadata.version,
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "controlApp/src/host/main.ts",
      define: {
        MOCHI_DEVELOPMENT: JSON.stringify(
          process.env.MOCHI_DESKTOP_DEVELOPMENT === "1",
        ),
        // Validated here so an invalid packager input fails the build, not setup.
        MOCHI_PACKAGE_TRUST: packageTrustFromEnvironment(
          process.env.MOCHI_PACKAGE_TRUST,
        )
          ? JSON.stringify(process.env.MOCHI_PACKAGE_TRUST)
          : "undefined",
      },
    },
    copy: { "controlApp/.build/views": "views" },
    buildFolder: "controlApp/.build/electrobun",
    artifactFolder: "controlApp/.build/artifacts",
    mac: {
      createDmg: false,
      codesign: false,
      notarize: false,
      bundleCEF: false,
      bundleWGPU: false,
      defaultRenderer: "native",
      icons: "controlApp/.build/Mochi.iconset",
    },
  },
  runtime: { exitOnLastWindowClosed: false },
  scripts: { postBuild: "script/capture_desktop.ts" },
  release: { generatePatch: false },
} satisfies ElectrobunConfig;
