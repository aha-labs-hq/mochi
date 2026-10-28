import type { ConnectorCatalogProjection } from "../../../src/control/connectorSnapshot.ts";
import type { ExperienceScene } from "../shared/experiencePreview.ts";
import { type DesktopSnapshot, initialSnapshot } from "../shared/model.ts";

/**
 * The preview describes one connector catalog, exactly as a real Bot publishes
 * it, so the sample cannot show a GitHub state the product could not produce.
 */
function previewCatalog(
  repositories: readonly {
    number: number;
    fullName: string;
    selected: boolean;
  }[],
  connection: {
    status: "connected" | "authorizing" | "disconnected";
    login: string | null;
  } = { status: "connected", login: "example" },
): ConnectorCatalogProjection {
  const status: ConnectorCatalogProjection["connections"][number]["status"] =
    connection.status === "connected"
      ? "ready"
      : connection.status === "authorizing"
        ? "authorizing"
        : "reauthorization_required";
  if (connection.status === "disconnected") {
    return { revision: `sha256:${"0".repeat(64)}`, connections: [] };
  }
  return {
    revision: `sha256:${"0".repeat(64)}`,
    connections: [
      {
        connectionId: `github:${connection.login ? 1 : 0}`,
        providerId: "github",
        providerDisplayName: "GitHub",
        status,
        accountDisplayName: connection.login,
        problem: null,
        grantedScopes: [],
        resourceScope: {
          status: status === "ready" ? "ready" : "unavailable",
          selectedCount: repositories.filter(
            (repository) => repository.selected,
          ).length,
          ...(status === "ready" ? {} : { problem: "connection_unavailable" }),
        },
        resources: repositories.map((repository) => ({
          resourceId: `repository:${repository.number}`,
          resourceType: "repository",
          displayName: repository.fullName,
          selectionId: repository.selected ? "0".repeat(32) : null,
          selected: repository.selected,
          ownerId: "1",
          visibility: "private",
          writable: true,
        })),
        capabilities: [],
      },
    ],
  };
}

/** The sample roster needs one stable identity; it never leaves the renderer. */
const PREVIEW_BOT_ID = "00000000-0000-4000-8000-000000000000";

/** Clearly labelled, renderer-only samples. Never merge with or persist host facts. */
export function experienceSample(scene: ExperienceScene): DesktopSnapshot {
  const sample: DesktopSnapshot = {
    ...initialSnapshot("预览", true),
    phase: "listening",
    installed: true,
    loaded: true,
    controlReady: true,
    eventStreamReady: true,
    account: {
      status: "signedIn",
      account: {
        provider: "openai-codex",
        authType: "oauth",
        subscription: true,
      },
      connections: [
        { provider: "openai-codex", authType: "oauth", subscription: true },
      ],
    },
    feishu: {
      active: {
        brand: "feishu" as const,
        state: "ready",
        bot: { name: "麻薯 · 示例", avatarUrl: null },
      },
      candidate: null,
    },

    bots: [
      {
        botId: PREVIEW_BOT_ID,
        characterId: "mochi",
        groupCount: 1,
        projectCount: 1,
        label: "麻薯 · 示例",
        enabled: true,
        lifecycle: "listening",
        phase: "listening",
        problemCode: null,
      },
    ],
    selectedBotId: PREVIEW_BOT_ID,
    // The preview describes one catalog, exactly as a real Bot publishes it.
    connectorCatalog: previewCatalog([
      { number: 1, fullName: "example/our-project", selected: true },
      { number: 2, fullName: "example/design-notes", selected: false },
    ]),
    feishuGroups: [
      {
        id: "preview-group",
        name: "示例工作群",
        avatarUrl: null,
        enabled: true,
      },
    ],
    policy: { model: "示例模型", reasoningEffort: "high" },
    queueDepth: 0,
    contextPercent: 20,
  };
  switch (scene) {
    case "location":
      sample.locationReady = false;
      sample.setup = "install";
      break;
    case "install":
      sample.setup = "install";
      break;
    case "checking":
      sample.setup = "checking";
      sample.account = { status: "unknown" };
      break;
    case "signIn":
      sample.setup = "signIn";
      sample.account = { status: "signedOut" };
      break;
    case "signingIn":
      sample.setup = "signingIn";
      sample.account = { status: "signingIn" };
      sample.canReopenLogin = true;
      break;
    case "ready":
      sample.setup = "ready";
      break;
    case "initializing":
      sample.setup = "initializing";
      break;
    case "feishu":
      sample.feishu = { active: null, candidate: null };
      break;
    case "feishuScan":
      sample.feishu = {
        active: null,
        candidate: {
          brand: null,
          state: "registering",
          bot: null,
          problem: null,
        },
      };
      sample.canReopenFeishuConnection = true;
      break;
    case "feishuChecking":
      sample.feishu = {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "checking",
          bot: null,
          problem: null,
        },
      };
      break;
    case "feishuReady":
      sample.feishu = {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "ready",
          bot: { name: "麻薯 · 示例", avatarUrl: null },
          problem: null,
        },
      };
      break;
    case "feishuFailure":
      sample.feishu = {
        active: null,
        candidate: {
          brand: "feishu" as const,
          state: "needsAction",
          bot: null,
          problem: "permissions_required",
        },
      };
      break;
    case "github":
      sample.connectorCatalog = previewCatalog([], {
        status: "disconnected",
        login: null,
      });
      break;
    case "githubAuthorizing":
      sample.connectorCatalog = previewCatalog([], {
        status: "authorizing",
        login: null,
      });
      sample.canReopenGitHubLogin = true;
      break;
    case "projects":
      // Authorized, but nothing chosen yet: the state first-run setup waits on.
      sample.connectorCatalog = previewCatalog([
        { number: 1, fullName: "example/our-project", selected: false },
        { number: 2, fullName: "example/design-notes", selected: false },
      ]);
      break;
    case "emptyGroups":
      sample.feishuGroups = [];
      break;
    case "encounter":
    case "peek":
    case "jump":
    case "landing":
    case "intro":
    case "complete":
    case "companion":
      break;
  }
  return sample;
}
