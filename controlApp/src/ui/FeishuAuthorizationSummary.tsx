import type { ConnectionState } from "./connectorDirectory.ts";
import {
  feishuAuthorizationGroups,
  feishuScopeLabel,
} from "./feishuAuthorization.ts";
import { Glyph } from "./Glyph.tsx";

/** Shows the actual Feishu grant separately from Mochi's implemented actions. */
export function FeishuAuthorizationSummary({
  grantedScopes,
  selectedResourceCount,
  connectionState,
  resourceScopeStatus,
}: {
  grantedScopes: readonly string[];
  selectedResourceCount: number;
  connectionState: ConnectionState;
  resourceScopeStatus: "ready" | "checking" | "unavailable";
}) {
  const groups = feishuAuthorizationGroups(grantedScopes);
  const operational = connectionState === "ready";
  const fixedScopeReady = resourceScopeStatus === "ready";
  return (
    <section
      aria-label="机器人权限"
      data-feishu-authorization
      data-feishu-scope-count={grantedScopes.length}
      className="space-y-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm leading-6 font-semibold text-ink">机器人权限</h3>
        <span className="text-xs">
          {grantedScopes.length > 0
            ? operational
              ? `${grantedScopes.length} 项已授权`
              : `${grantedScopes.length} 项上次确认`
            : "待确认"}
        </span>
        <p className="w-full text-xs leading-5">
          {grantedScopes.length > 0
            ? `平台给了这个机器人 ${grantedScopes.length} 项权限，用来在群里收发消息、读取文档和知识库。${operational ? "" : "当前连接还需要确认。"}能读到哪份文档，还要看它被分享到了哪里。`
            : "还没有读到这个机器人的权限。"}
        </p>
      </header>
      <dl className="settings-grid gap-y-3 text-xs leading-5">
        <div className="col-span-3 min-w-0 @max-[420px]/detail:col-span-6">
          <dt>机器人权限</dt>
          <dd className="mt-0.5 text-sm leading-5 font-medium text-ink">
            {grantedScopes.length > 0
              ? operational
                ? "已生效"
                : "上次确认，待复核"
              : "待确认"}
          </dd>
          <dd>
            {grantedScopes.length > 0
              ? operational
                ? `${grantedScopes.length} 项`
                : "上次读到的权限，连接恢复后复核"
              : "还没有读到"}
          </dd>
        </div>
        <div className="col-span-3 min-w-0 @max-[420px]/detail:col-span-6">
          <dt>一直参考的资料</dt>
          <dd className="mt-0.5 text-sm leading-5 font-medium text-ink">
            {selectedResourceCount > 0
              ? fixedScopeReady
                ? `${selectedResourceCount} 份`
                : `${selectedResourceCount} 份，正在确认`
              : "没有固定的资料"}
          </dd>
          <dd>
            {!operational
              ? "连接确认前，不会参考固定的资料"
              : fixedScopeReady
                ? "群里临时发的链接也会读取"
                : "连接仍有效，固定的资料还在确认"}
          </dd>
        </div>
      </dl>
      {groups.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-hairline bg-card">
          {groups.map((group) => (
            <details
              key={group.id}
              className="group/scope border-t border-hairline first:border-t-0"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 transition-colors duration-150 hover:bg-ink/3 motion-reduce:transition-none control-focus [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 flex-1 text-sm font-medium text-ink">
                  {group.title}
                </span>
                <span className="text-xs text-muted">
                  {group.scopes.length} 项
                </span>
                <Glyph
                  name="chevronDown"
                  size={14}
                  className="text-muted transition-transform duration-150 group-open/scope:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <div className="space-y-2 px-4 pb-3.5">
                <p className="text-xs leading-5 text-muted">
                  {group.description}
                </p>
                <ul className="list-none space-y-1.5">
                  {group.scopes.map((scope) => (
                    <li
                      key={scope}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-ink"
                    >
                      <span>{feishuScopeLabel(scope)}</span>
                      <code className="break-all text-2xs text-muted">
                        {scope}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted">
          连接确认后，这里会显示完整授权范围。
        </p>
      )}
    </section>
  );
}
