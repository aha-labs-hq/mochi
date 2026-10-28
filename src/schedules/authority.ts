import type { ConnectorCatalog } from "../connectors/protocol.ts";
import type { ConnectorSelectionStore } from "../connectors/selectionStore.ts";
import { isConnectorIdentifier } from "../connectors/selectionStore.ts";
import type { ScheduleResource } from "./store.ts";

export interface ScheduleResourceReference {
  connectionId: string;
  resourceId: string;
}

/** Snapshot only the resources explicitly named for this work, with their
 * existing selection identity. Adding a project later cannot expand the job. */
export function bindScheduleResources(
  botId: string,
  references: readonly ScheduleResourceReference[],
  catalog: ConnectorCatalog,
  selections: ConnectorSelectionStore,
): ScheduleResource[] {
  if (
    catalog.botId !== botId ||
    !Array.isArray(references) ||
    references.length > 20
  )
    throw new Error("安排资源范围无效。");
  const seen = new Set<string>();
  return references.map((reference) => {
    if (
      !reference ||
      Object.keys(reference).sort().join(",") !== "connectionId,resourceId" ||
      !isConnectorIdentifier(reference.connectionId) ||
      !isConnectorIdentifier(reference.resourceId) ||
      seen.has(`${reference.connectionId}/${reference.resourceId}`)
    )
      throw new Error("安排资源引用无效。");
    seen.add(`${reference.connectionId}/${reference.resourceId}`);
    const connection = catalog.connections.find(
      (item) => item.connectionId === reference.connectionId,
    );
    const resource = connection?.resources.find(
      (item) => item.id === reference.resourceId,
    );
    const selection = selections
      .connectorSelections(reference.connectionId)
      .find((item) => item.resourceId === reference.resourceId);
    if (connection?.status !== "ready" || !resource?.selected || !selection)
      throw new Error("请先明确选择安排需要读取的资源。");
    return { ...reference, selectionId: selection.selectionId };
  });
}

/** Repeat at dispatch and at each connector read; a saved job is not a grant. */
export function scheduleResourcesStillSelected(
  botId: string,
  resources: readonly ScheduleResource[],
  catalog: ConnectorCatalog,
  selections: ConnectorSelectionStore,
): boolean {
  if (catalog.botId !== botId) return false;
  return resources.every((resource) => {
    const connection = catalog.connections.find(
      (item) => item.connectionId === resource.connectionId,
    );
    return (
      connection?.status === "ready" &&
      connection.resources.some(
        (item) => item.id === resource.resourceId && item.selected,
      ) &&
      selections
        .connectorSelections(resource.connectionId)
        .some(
          (item) =>
            item.resourceId === resource.resourceId &&
            item.selectionId === resource.selectionId,
        )
    );
  });
}
