import type { ReactNode } from "react";
import type { DesktopSnapshot } from "../shared/model.ts";
import type { SettingsRoute } from "../shared/settings.ts";
import { StatusMark } from "./Controls.tsx";
import {
  type ConnectorDirectoryModel,
  connectorDirectoryModels,
} from "./connectorDirectory.ts";
import { Glyph } from "./Glyph.tsx";
import { SettingsIcon } from "./SettingsIcon.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";

export function ConnectorsSettings({
  snapshot,
  navigate,
}: {
  snapshot: DesktopSnapshot;
  navigate(route: SettingsRoute): void;
}) {
  const models = connectorDirectoryModels(snapshot.connectorCatalog);
  const connectedCount = models.filter(
    (model) => model.connection.state === "ready",
  ).length;
  const confirmed = snapshot.connectorCatalog !== null;

  return (
    <section aria-labelledby="connector-directory-heading">
      <SettingsSectionHeader
        id="connector-directory-heading"
        title="当前连接"
        actions={
          <span className={connectedCount > 0 ? "text-status-good" : undefined}>
            {confirmed ? `${connectedCount} 个已连接` : "状态待确认"}
          </span>
        }
      />
      <div className="space-y-3">
        {models.map((model) => (
          <ConnectorCard key={model.id} model={model} navigate={navigate} />
        ))}
      </div>
      <p className="settings-note mt-6 max-w-[42em]">
        访问范围决定能接触哪些内容；可用操作决定能做什么。断开连接不会删除已有对话和记忆。
      </p>
    </section>
  );
}

/**
 * The service icon hangs in the card's margin; name, facts and the manage
 * action all start from the words' axis, so every card reads in one sweep.
 */
function ConnectorCard({
  model,
  navigate,
}: {
  model: ConnectorDirectoryModel;
  navigate(route: SettingsRoute): void;
}) {
  const route = model.route;
  const status = model.connection.status;
  return (
    <article
      aria-label={`${model.title} 连接`}
      data-provider-id={model.providerId}
      className="@container/connector rounded-md border border-hairline bg-card py-4 pr-4 pl-5"
    >
      <div data-connector-zone="identity">
        <header className="flex items-start gap-4">
          <SettingsIcon name={model.icon} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3">
              <h3 className="text-sm leading-6 font-semibold">{model.title}</h3>
              <StatusMark tone={status.tone}>{status.label}</StatusMark>
            </div>
            <p className="settings-note">{model.description}</p>
          </div>
          {route ? (
            <button
              type="button"
              aria-label={
                model.connection.state === "missing"
                  ? model.management.label
                  : `打开 ${model.title}`
              }
              data-route-focus={`connector:${model.id}`}
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                navigate(route);
              }}
              className="-mt-0.5 inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm pr-1 pl-2 text-xs font-medium text-action transition-colors duration-150 hover:bg-action-soft motion-reduce:transition-none control-focus"
            >
              {model.management.label}
              <Glyph name="chevronRight" size={14} />
            </button>
          ) : (
            !model.management.available && (
              <span className="max-w-[13rem] shrink-0 text-right text-xs leading-6 text-muted">
                {model.management.label}
              </span>
            )
          )}
        </header>
      </div>
      <div data-connector-zone="details" className="mt-4 pl-13">
        <dl className="settings-grid gap-y-4">
          <Field label="连接身份">
            <p className="[overflow-wrap:anywhere]">
              {model.connection.identity}
            </p>
          </Field>
          <Field label="访问范围">
            <p
              className={
                model.access.items.length === 0 ? "text-muted" : undefined
              }
            >
              {model.access.summary}
            </p>
            {model.access.items.length > 0 && (
              <ul className="mt-1 list-none space-y-0.5 text-xs leading-5 text-muted">
                {model.access.items.map((item) => (
                  <li key={item.id} className="[overflow-wrap:anywhere]">
                    {item.name}
                  </li>
                ))}
                {model.access.remainingCount > 0 && (
                  <li>另有 {model.access.remainingCount} 项</li>
                )}
              </ul>
            )}
          </Field>
          <Field label="可用操作">
            <OperationList model={model} />
          </Field>
        </dl>
      </div>
    </article>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="col-span-2 min-w-0 @max-[440px]/connector:col-span-6">
      <dt className="settings-note">{label}</dt>
      <dd className="mt-1 text-sm leading-5">{children}</dd>
    </div>
  );
}

function OperationList({ model }: { model: ConnectorDirectoryModel }) {
  const groups = model.operations.filter(
    (group) =>
      group.available.length > 0 ||
      group.selectionRequiredCount > 0 ||
      group.selectionOptionalCount > 0 ||
      group.blockedCount > 0,
  );
  if (groups.length === 0)
    return <p className="text-muted">{model.operationEmptyLabel}</p>;
  return (
    <div className="space-y-1">
      {groups.map((group) => {
        const kind = group.kind === "read" ? "读取" : "更改";
        return (
          <div key={group.kind} className="text-xs leading-5 text-muted">
            {group.available.length > 0 && (
              <details className="group/operation">
                <summary className="-ml-1 inline-flex cursor-pointer list-none items-center gap-0.5 rounded-sm px-1 text-sm leading-5 text-ink control-focus [&::-webkit-details-marker]:hidden">
                  {kind} · {group.available.length} 项
                  <Glyph
                    name="chevronDown"
                    size={12}
                    className="text-muted transition-transform duration-150 group-open/operation:rotate-180 motion-reduce:transition-none"
                  />
                </summary>
                <ul className="mt-1 mb-1 list-none space-y-0.5">
                  {group.available.map((capability) => (
                    <li
                      key={capability.id}
                      className="[overflow-wrap:anywhere]"
                    >
                      {capability.displayName}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {group.selectionRequiredCount > 0 && (
              <p>
                {kind} · {group.selectionRequiredCount} 项待设置范围
              </p>
            )}
            {group.selectionOptionalCount > 0 && (
              <p>
                {kind} · {group.selectionOptionalCount} 项
                {model.selectionOptionalLabel}
              </p>
            )}
            {group.blockedCount > 0 && (
              <p>
                {kind} · {group.blockedCount} 项受限
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
