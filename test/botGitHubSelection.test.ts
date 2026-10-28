import { afterEach, describe, expect, test } from "bun:test";
import { GitHubProjectSelection } from "../src/github/botSelection.ts";
import type { ConnectorResourceSelection, ConnectorSelectionStore } from "../src/connectors/selectionStore.ts";
import { GitHubConnectionError } from "../src/github/integration.ts";
import type { GitHubCatalogRepository, GitHubSelection } from "../src/github/repository.ts";
import type { GitHubAuthority, GitHubConnection } from "../src/github/connection.ts";

const CATALOG: GitHubCatalogRepository[] = [
  { id: 20, ownerId: 10, fullName: "customer/alpha", installationId: 30, private: true, canWriteIssues: true },
  { id: 21, ownerId: 10, fullName: "customer/beta", installationId: 30, private: false, canWriteIssues: false },
  { id: 22, ownerId: 11, fullName: "other/gamma", installationId: 31, private: true, canWriteIssues: true },
];

/**
 * A selection store with the same replace semantics as the Bot's own state.
 *
 * It holds the shared connector rows, so this suite proves GitHub's selection
 * really does live in the provider-neutral table rather than a GitHub one.
 */
class MemorySelectionStore implements ConnectorSelectionStore {
  rows: ConnectorResourceSelection[] = [];
  writes = 0;
  connectorSelections(connectionId?: string): ConnectorResourceSelection[] {
    return this.rows
      .filter((row) => connectionId === undefined || row.connectionId === connectionId)
      .map((row) => ({ ...row }));
  }
  connectorSelectionConnectionIds(): readonly string[] {
    return [...new Set(this.rows.map((row) => row.connectionId))];
  }
  replaceConnectorSelections(connectionId: string, next: readonly ConnectorResourceSelection[]): void {
    this.rows = [
      ...this.rows.filter((row) => row.connectionId !== connectionId),
      ...next.map((row) => ({ ...row })),
    ];
    this.writes++;
  }
  /** The stored choices, in the shape this suite asserts against. */
  get selections(): GitHubSelection[] {
    return this.rows.map((row) => ({
      repositoryId: Number(row.resourceId.slice(row.resourceId.indexOf(":") + 1)),
      selectionId: row.selectionId,
    }));
  }
}

function connection(catalog: readonly GitHubCatalogRepository[] = CATALOG) {
  const scopes: unknown[] = [];
  const value = {
    snapshot() { return { status: "connected" as const, account: { id: 1, login: "customer" }, problem: null }; },
    authority(): GitHubAuthority { return { accountId: 1, grantId: "a".repeat(32) }; },
    async catalog(): Promise<readonly GitHubCatalogRepository[]> { return catalog.map((project) => ({ ...project })); },
    async repositoryAccess(scope: unknown) { scopes.push(scope); return { scope, fullName: "customer/alpha", request: async () => null }; },
  };
  return { connection: value as unknown as GitHubConnection, scopes };
}

function selection(store = new MemorySelectionStore(), catalog = CATALOG) {
  const f = connection(catalog);
  return { ...f, store, selection: new GitHubProjectSelection(f.connection, store) };
}

afterEach(() => { /* fixtures hold no process resources */ });

describe("one Bot's GitHub project selection", () => {
  test("a fresh Bot has selected nothing while the whole granted catalog stays visible", async () => {
    const f = selection();
    expect(await f.selection.selectedProjects()).toEqual([]);
    expect((await f.selection.discover()).map((project) => [project.fullName, project.selected]))
      .toEqual([["customer/alpha", false], ["customer/beta", false], ["other/gamma", false]]);
    expect(f.store.selections).toEqual([]);
  });

  test("the last directory proof belongs to one grant and is cleared on failure", async () => {
    const f = selection();
    expect(f.selection.catalogSnapshot()).toBeNull();
    await f.selection.discover();
    expect(f.selection.catalogSnapshot()!.map((project) => project.selected)).toEqual([false, false, false]);
    const raw = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]>; authority(): GitHubAuthority };
    raw.authority = () => ({ accountId: 1, grantId: "b".repeat(32) });
    expect(f.selection.catalogSnapshot()).toBeNull();
    await f.selection.discover();
    expect(f.selection.catalogSnapshot()).not.toBeNull();
    raw.catalog = async () => { throw new Error("provider unavailable"); };
    await expect(f.selection.discover()).rejects.toThrow();
    expect(f.selection.catalogSnapshot()).toBeNull();
  });

  test("a pending repository proof does not publish a false resource loss or grant early access", async () => {
    const f = selection();
    await f.selection.select([20]);
    await f.selection.discover();
    const previous = f.selection.catalogSnapshot();
    const raw = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]> };
    let finish!: (value: readonly GitHubCatalogRepository[]) => void;
    raw.catalog = () => new Promise((resolve) => { finish = resolve; });
    const access = f.selection.repositoryAccess(20);
    try {
      expect(f.selection.catalogSnapshot()).toEqual(previous);
      expect(f.scopes).toEqual([]);
    } finally {
      finish(CATALOG);
      await access;
    }
    expect(f.scopes).toHaveLength(1);

    let fail!: (error: Error) => void;
    raw.catalog = () => new Promise((_, reject) => { fail = reject; });
    const rejected = f.selection.repositoryAccess(20).catch((error: unknown) => error);
    expect(f.selection.catalogSnapshot()).toEqual(previous);
    fail(new Error("provider unavailable"));
    expect(await rejected).toMatchObject({ message: "provider unavailable" });
    expect(f.selection.catalogSnapshot()).toBeNull();
    expect(f.scopes).toHaveLength(1);
  });

  test("keeps a local display snapshot without treating it as a live capability", async () => {
    const f = selection();
    await f.selection.select([20]);
    expect(f.selection.savedProjectsSnapshot()).toEqual([
      {
        id: 20,
        ownerId: 10,
        fullName: "customer/alpha",
        installationId: 30,
        private: true,
        canWriteIssues: true,
        selected: true,
      },
    ]);
    const broken = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]> };
    broken.catalog = async () => { throw new GitHubConnectionError("provider_unavailable"); };
    expect(f.selection.savedProjectsSnapshot()).toHaveLength(1);
    await expect(f.selection.discover()).rejects.toThrow("provider_unavailable");
  });

  test("does not display a previous same-account selection under a new grant", async () => {
    const f = selection();
    await f.selection.select([20]);
    const raw = f.connection as unknown as { authority(): GitHubAuthority };
    raw.authority = () => ({ accountId: 1, grantId: "b".repeat(32) });
    expect(f.selection.savedProjectsSnapshot()).toEqual([]);
  });

  test("invalidates selections across grants and retires rows for old accounts", async () => {
    const f = selection();
    await f.selection.select([20]);
    const current = f.store.rows[0]!;
    f.store.rows.push({ ...current, connectionId: "github:2" });
    const raw = f.connection as unknown as { authority(): GitHubAuthority };
    raw.authority = () => ({ accountId: 1, grantId: "b".repeat(32) });
    expect((await f.selection.discover()).filter((project) => project.selected)).toEqual([]);
    expect(f.store.rows).toEqual([]);
  });

  test("a disconnect clears every GitHub account's choice and leaves other providers alone", async () => {
    const f = selection();
    await f.selection.select([20]);
    await f.selection.discover();
    const current = f.store.rows[0]!;
    f.store.rows.push({ ...current, connectionId: "github:2" }, { ...current, connectionId: "feishu:cli_app" });
    f.selection.clear();
    expect(f.store.rows.map((row) => row.connectionId)).toEqual(["feishu:cli_app"]);
    expect(f.selection.catalogSnapshot()).toBeNull();
  });

  test("re-selection keeps an untouched choice and issues a new identity for a re-added one", async () => {
    const f = selection();
    await f.selection.select([20, 21]);
    const first = f.store.selections.map((record): [number, string] => [record.repositoryId, record.selectionId]);
    expect(first.map(([id]) => id)).toEqual([20, 21]);
    expect((await f.selection.selectedProjects()).map((project) => project.id)).toEqual([20, 21]);

    // Narrowing the selection leaves the surviving choice untouched, so an in-flight
    // Issue action on it is still the same authority.
    await f.selection.select([20]);
    expect(f.store.selections.map((entry): [number, string] => [entry.repositoryId, entry.selectionId])).toEqual([first[0]!]);

    // Re-adding a repository creates a fresh identity: the previous authority for
    // it was revoked by deselection and must not come back to life.
    await f.selection.select([20, 21]);
    expect(f.store.selections.map((entry) => entry.repositoryId)).toEqual([20, 21]);
    expect(f.store.selections[0]!.selectionId).toBe(first[0]![1]);
    expect(f.store.selections[1]!.selectionId).not.toBe(first[1]![1]);
  });

  test("a repository the grant does not prove can never be selected", async () => {
    const f = selection();
    await expect(f.selection.select([999])).rejects.toThrow("grant_unavailable");
    expect(f.store.writes).toBe(0);
    await expect(f.selection.select([20, 20])).rejects.toThrow("repository_not_selected");
    await expect(f.selection.select([-1])).rejects.toThrow("repository_not_selected");
    expect(f.store.writes).toBe(0);
  });

  test("a capability carries the Bot's own selection identity and the proven repository facts", async () => {
    const f = selection();
    await f.selection.select([22]);
    const access = await f.selection.repositoryAccess(22);
    expect(access.scope).toEqual({
      accountId: 1,
      grantId: "a".repeat(32),
      repositoryId: 22,
      ownerId: 11,
      installationId: 31,
      selectionId: f.store.selections[0]!.selectionId,
    });
  });

  test("an unselected or unknown repository has no capability at all", async () => {
    const f = selection();
    await f.selection.select([20]);
    await expect(f.selection.repositoryAccess(21)).rejects.toThrow("repository_not_selected");
    await expect(f.selection.repositoryAccess(999)).rejects.toThrow("repository_not_selected");
    // No scope is ever derived for a repository this Bot did not select.
    expect(f.scopes).toHaveLength(0);
    await f.selection.repositoryAccess(20);
    expect(f.scopes).toHaveLength(1);
  });

  test("a repository the grant no longer proves is dropped from the selection durably", async () => {
    const f = selection();
    await f.selection.select([20, 21]);
    expect(f.store.writes).toBe(1);
    // The second repository is gone from the grant: a revoked or transferred repo.
    const reduced = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]> };
    const original = reduced.catalog;
    reduced.catalog = async () => (await original()).filter((project) => project.id !== 21);
    expect((await f.selection.selectedProjects()).map((project) => project.id)).toEqual([20]);
    expect(f.store.selections.map((record) => record.repositoryId)).toEqual([20]);
    expect(f.store.writes).toBe(2);
    // It is gone from storage, so it cannot be used without a fresh selection.
    await expect(f.selection.repositoryAccess(21)).rejects.toThrow("repository_not_selected");
  });

  test("a moved installation invalidates the stored selection instead of reusing its identity", async () => {
    const f = selection();
    await f.selection.select([20]);
    const previous = f.store.selections[0]!.selectionId;
    const moved = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]> };
    moved.catalog = async () => CATALOG.map((project) => project.installationId === 30
      ? { ...project, installationId: 31 } : project);
    expect(await f.selection.selectedProjects()).toEqual([]);
    expect(f.store.selections).toEqual([]);
    await f.selection.select([20]);
    // The new choice is bound to the installation that now proves it, and it is a
    // different identity from the one the old installation carried.
    expect(JSON.parse(f.store.rows[0]!.address)).toMatchObject({ binding: "31" });
    expect(f.store.selections[0]!.selectionId).not.toBe(previous);
  });

  test("a catalog failure is never answered with a stale selection", async () => {
    const f = selection();
    await f.selection.select([20]);
    const broken = f.connection as unknown as { catalog(): Promise<readonly GitHubCatalogRepository[]> };
    broken.catalog = async () => { throw new GitHubConnectionError("sign_in_required"); };
    await expect(f.selection.selectedProjects()).rejects.toThrow("sign_in_required");
    await expect(f.selection.discover()).rejects.toThrow("sign_in_required");
    // The durable record is untouched: a failed proof must not silently deselect.
    expect(f.store.selections.map((record) => record.repositoryId)).toEqual([20]);
  });

  test("two Bots on one grant keep independent selections", async () => {
    const grant = connection();
    const first = new GitHubProjectSelection(grant.connection, new MemorySelectionStore());
    const second = new GitHubProjectSelection(grant.connection, new MemorySelectionStore());
    await first.select([20]);
    await second.select([21, 22]);
    expect((await first.selectedProjects()).map((project) => project.id)).toEqual([20]);
    expect((await second.selectedProjects()).map((project) => project.id)).toEqual([21, 22]);
  });
});
