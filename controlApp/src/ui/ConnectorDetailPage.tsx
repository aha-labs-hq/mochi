import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import type {
  ConnectorCapabilityAvailability,
  ConnectorConnectionProjection,
} from "../../../src/control/connectorSnapshot.ts";
import { StatusMark } from "./Controls.tsx";
import type { ConnectorStatus } from "./connectorDirectory.ts";
import { Glyph } from "./Glyph.tsx";
import { SettingsIcon, type SettingsIconName } from "./SettingsIcon.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";

/**
 * One connection object, introduced once: its icon, its name, and directly
 * beneath the name its state, account and purpose. Nothing about the object
 * is split off into a second strip or pushed to the far edge.
 */
export function ConnectorDetailPage({
  label,
  icon,
  description,
  identity,
  status,
  context,
  recovery,
  children,
}: {
  label: string;
  icon: SettingsIconName;
  description: string;
  identity: string;
  /** From `connectorStatusOf`, the one owner of a connection's status. */
  status: ConnectorStatus;
  context?: string;
  recovery?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="@container/detail space-y-10"
    >
      <header data-connector-section="connection">
        <div className="flex items-center gap-4">
          <SettingsIcon name={icon} size={44} />
          <div className="min-w-0 flex-1">
            <h1
              id={headingId}
              tabIndex={-1}
              className="text-display font-semibold tracking-[-0.02em] [overflow-wrap:anywhere] outline-none"
            >
              {label}
            </h1>
            {/* Each separator travels with the fact it introduces, so a wrap
                never leaves a dot at the end of a line. */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-5 text-muted">
              <StatusMark tone={status.tone}>{status.label}</StatusMark>
              <span className="[overflow-wrap:anywhere]">
                <span aria-hidden>· </span>
                <span className="font-medium text-ink">{identity}</span>
              </span>
              <span>
                <span aria-hidden>· </span>
                <span>{description}</span>
              </span>
              {context && (
                <span>
                  <span aria-hidden>· </span>
                  <span>{context}</span>
                </span>
              )}
            </p>
          </div>
        </div>
        {recovery && <div className="mt-6 space-y-3">{recovery}</div>}
      </header>
      {children}
    </section>
  );
}

export function ConnectorSection({
  id,
  title,
  description,
  aside,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} data-connector-section={id}>
      <SettingsSectionHeader
        id={id}
        title={title}
        description={description}
        actions={aside}
      />
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Low-frequency grant and disconnect actions stay one deliberate step away. */
export function ConnectorManagement({
  children,
  defaultOpen = false,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      data-connector-section="management"
      open={defaultOpen}
      className="group/management border-t border-hairline pt-3"
    >
      <summary className="-mx-2 flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-sm px-2 text-sm leading-6 font-semibold transition-colors duration-150 hover:bg-ink/3 motion-reduce:transition-none control-focus [&::-webkit-details-marker]:hidden">
        <span className="flex-1">连接管理</span>
        <Glyph
          name="chevronDown"
          size={14}
          className="text-muted transition-transform duration-150 group-open/management:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="space-y-4 pt-3 text-xs leading-5 text-muted">
        {children}
      </div>
    </details>
  );
}

const AVAILABILITY: Record<ConnectorCapabilityAvailability, string> = {
  ready: "可用",
  selection_required: "设置访问范围后可用",
  resource_checking: "正在确认固定资料",
  resource_unavailable: "固定资料暂不可用",
  authorization_required: "尚未获得所需授权",
  read_only: "所选内容只读",
  access_unconfirmed: "写入权限未确认",
  connection_unavailable: "连接暂不可用",
};

interface SelectionCopy {
  readonly preview: string;
  readonly optional: string;
}

function operationSummary(
  ready: number,
  selectionRequired: number,
  selectionOptional: number,
  blocked: number,
): string {
  const labels: string[] = [];
  if (ready > 0) labels.push(`${ready} 项可用`);
  if (selectionRequired > 0) labels.push(`${selectionRequired} 项待设置范围`);
  if (selectionOptional > 0) labels.push(`${selectionOptional} 项可选范围`);
  if (blocked > 0) labels.push(`${blocked} 项受限`);
  return labels.join(" · ") || "暂无可用项";
}

/**
 * Read and write are a quiet table under the scope, one step below its list:
 * labels on the form axis, rules between rows, no second card. Implemented
 * operations retain their catalog availability during an outage.
 */
export function ConnectorOperations({
  connection,
  selectionCopy,
}: {
  connection: ConnectorConnectionProjection | undefined;
  selectionCopy?: SelectionCopy;
}) {
  if (!connection) return null;
  const capabilities = connection.capabilities;
  const copy = selectionCopy ?? {
    preview: "保存范围后可跨消息使用",
    optional: "可选范围",
  };
  const groups = (["read", "write"] as const)
    .map((kind) => ({
      kind,
      items: capabilities.filter((capability) => capability.operation === kind),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <section aria-label="访问范围内的操作" className="pt-3">
      <p className="mb-1 text-xs leading-5 text-muted">可用操作</p>
      {capabilities.length === 0 ? (
        <p className="text-xs leading-5 text-muted">
          暂无已接入且已授权的操作。授权信息见连接管理。
        </p>
      ) : (
        <div className="border-y border-hairline">
          {groups.map(({ kind, items }) => {
            const readyItems = items.filter(
              (capability) => capability.availability === "ready",
            );
            const ready = readyItems.length;
            const selectionRequired = items.filter(
              (capability) =>
                capability.availability === "selection_required" &&
                capability.resourceSelection === "required",
            ).length;
            const selectionOptional = items.filter(
              (capability) =>
                capability.availability === "selection_required" &&
                capability.resourceSelection === "optional",
            ).length;
            const blocked =
              items.length - ready - selectionRequired - selectionOptional;
            const preview =
              ready > 0
                ? readyItems
                    .slice(0, 2)
                    .map((item) => item.displayName)
                    .join(" · ") + (ready > 2 ? "等" : "")
                : selectionOptional > 0 &&
                    selectionRequired === 0 &&
                    blocked === 0
                  ? copy.preview
                  : selectionRequired > 0 &&
                      selectionOptional === 0 &&
                      blocked === 0
                    ? "设置对应访问范围后即可使用"
                    : [
                        ...new Set(
                          items.map((item) =>
                            item.availability === "selection_required" &&
                            item.resourceSelection === "optional"
                              ? copy.optional
                              : AVAILABILITY[item.availability],
                          ),
                        ),
                      ].join(" · ");
            return (
              <details
                key={kind}
                className="group/operations border-t border-hairline first:border-t-0"
              >
                <summary className="settings-grid group/summary min-h-11 cursor-pointer list-none items-center py-2.5 control-focus [&::-webkit-details-marker]:hidden">
                  <span className="settings-label">
                    {kind === "read" ? "读取" : "写入"}
                  </span>
                  <span className="settings-value flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-xs leading-5 text-muted group-open/operations:invisible">
                      {preview}
                    </span>
                    <span className="shrink-0 text-xs leading-5 text-muted">
                      {operationSummary(
                        ready,
                        selectionRequired,
                        selectionOptional,
                        blocked,
                      )}
                    </span>
                    <Glyph
                      name="chevronDown"
                      size={14}
                      className="text-muted transition-transform duration-150 group-hover/summary:text-ink group-open/operations:rotate-180 motion-reduce:transition-none"
                    />
                  </span>
                </summary>
                <div className="settings-grid pb-3">
                  <span aria-hidden className="settings-label" />
                  <ul className="settings-value list-none space-y-1.5 text-xs leading-5">
                    {items.map((capability) => (
                      <li
                        key={capability.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-3"
                      >
                        <span>{capability.displayName}</span>
                        <span className="text-muted">
                          {capability.availability === "selection_required" &&
                          capability.resourceSelection === "optional"
                            ? copy.optional
                            : capability.availability === "selection_required"
                              ? "待设置范围"
                              : AVAILABILITY[capability.availability]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Consume an explicit focus intent in the commit that mounts its target. */
export function useConnectorEditorFocus() {
  const input = useRef<HTMLInputElement>(null);
  const entry = useRef<HTMLButtonElement>(null);
  const requested = useRef<"input" | "entry" | null>(null);
  useLayoutEffect(() => {
    if (requested.current === null) return;
    const target =
      requested.current === "input" ? input.current : entry.current;
    requested.current = null;
    target?.focus();
  });
  return {
    input,
    entry,
    requestFocus: (target: "input" | "entry") => {
      requested.current = target;
    },
  };
}
