import { ConnectorBroker } from "../src/connectors/broker.ts";
import { ConnectorRegistry } from "../src/connectors/registry.ts";
import { GitHubConnector } from "../src/connectors/github/adapter.ts";
import type { ConnectorResourceSelection } from "../src/connectors/selectionStore.ts";
import type { StateStore } from "../src/state.ts";
import type { BotGitHub, GitHubRepositoryAccess } from "../src/github/botAccess.ts";
import type { GitHubConnectionSnapshot } from "../src/github/repository.ts";
import type { IssueWorkflow } from "../src/issueWorkflow.ts";
import type { ConnectorAdapter } from "../src/connectors/protocol.ts";

const BOT_ID = "11111111-2222-4333-8444-555555555555";
const ACCOUNT_ID = 1;

/** A selection store that behaves like the Bot database without a SQLite file. */
export class MemoryConnectorSelections {
  readonly rows = new Map<string, ConnectorResourceSelection[]>();
  connectorSelections(connectionId: string): ConnectorResourceSelection[] {
    return this.rows.get(connectionId) ?? [];
  }
  connectorSelectionConnectionIds(): readonly string[] {
    return [...this.rows.keys()];
  }
  replaceConnectorSelections(connectionId: string, selections: readonly ConnectorResourceSelection[]): void {
    this.rows.set(connectionId, [...selections]);
  }
}

/**
 * A Bot whose GitHub connection and selection are fixed, so a connector call can
 * be driven through the real Broker with no network.
 */
export function githubBroker(options: {
  state: StateStore;
  issues: IssueWorkflow;
  selection: BotGitHub;
  status?: GitHubConnectionSnapshot["status"];
  account?: { id: number; login: string } | null;
  problem?: string | null;
  selected?: readonly number[];
  available?: readonly number[];
  additionalAdapters?: readonly ConnectorAdapter[];
}): { broker: ConnectorBroker; connectionId: string; selections: MemoryConnectorSelections } {
  const selections = new MemoryConnectorSelections();
  const account = options.account === undefined ? { id: ACCOUNT_ID, login: "customer" } : options.account;
  const connectionId = account ? `github:${account.id}` : "";
  if (account) {
    selections.replaceConnectorSelections(connectionId, (options.selected ?? [20]).map((repositoryId) => ({
      connectionId,
      resourceId: `repository:${repositoryId}`,
      resourceType: "repository",
      displayName: repositoryId === 20 ? "customer/mochi" : `customer/project-${repositoryId}`,
      address: String(repositoryId),
      selectionId: "a".repeat(32),
    })));
  }
  const registry = new ConnectorRegistry();
  for (const adapter of options.additionalAdapters ?? []) registry.register(adapter);
  registry.register(new GitHubConnector(
    {
      snapshot: () => ({
        status: options.status ?? "connected",
        account,
        problem: options.problem ?? null,
      }),
      selection: options.selection,
      catalogSnapshot: () => (options.available ?? options.selected ?? [20]).map((id) => ({ id, ownerId: 1, fullName: id === 20 ? "customer/mochi" : `customer/project-${id}`, installationId: 30, private: true, canWriteIssues: true, selected: (options.selected ?? [20]).includes(id) })),
    },
    options.issues,
  ));
  return { broker: new ConnectorBroker(registry, options.state), connectionId, selections };
}

/** The catalog revision a call must present, read from the Broker itself. */
export async function catalogRevision(broker: ConnectorBroker): Promise<string> {
  return (await broker.catalog(BOT_ID)).revision;
}

export { BOT_ID, ACCOUNT_ID };

/** A selection facade whose repository access is supplied by the caller. */
export function fixedSelection(
  access: (repositoryId: number) => Promise<GitHubRepositoryAccess>,
): BotGitHub {
  return {
    selectedProjects: async () => [],
    savedProjectsSnapshot: () => [],
    discover: async () => [],
    select: async () => {},
    repositoryAccess: access,
  };
}
