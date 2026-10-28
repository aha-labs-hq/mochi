import { Checkbox } from "@base-ui/react/checkbox";
import { useEffect, useState } from "react";
import {
  type GitHubProjectView,
  githubAccountOf,
  githubProblemOf,
  githubProjectsOf,
  githubStatusOf,
} from "../shared/connectorView.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import type { DesktopProblem } from "../shared/problem.ts";
import { Avatar } from "./Avatar.tsx";
import {
  ConnectorDetailPage,
  ConnectorManagement,
  ConnectorOperations,
  ConnectorSection,
  useConnectorEditorFocus,
} from "./ConnectorDetailPage.tsx";
import { Button } from "./Controls.tsx";
import { authorizationMethodLabel } from "./connectorAuthorization.ts";
import {
  connectorAuthorizationFor,
  connectorState,
  connectorStatusOf,
} from "./connectorDirectory.ts";
import { GitHubOwnerAvatar } from "./GitHubOwnerAvatar.tsx";
import { Glyph } from "./Glyph.tsx";
import { JourneyAction } from "./JourneyAction.tsx";
import { SettingsList, SettingsRow } from "./SettingsList.tsx";
import { cn, inlineError } from "./styles.ts";

function projectAccessLabel(project: GitHubProjectView): string {
  const visibility =
    project.visibility === "private"
      ? "私有项目"
      : project.visibility === "public"
        ? "公开项目"
        : "项目";
  const access =
    project.writable === true
      ? "可协作 Issue"
      : project.writable === false
        ? "只读访问"
        : "写入权限未确认";
  return `${visibility} · ${access}`;
}

/** The Bot keeps the project list current, so the page has nothing to refresh. */
export function ProjectsSettings({
  snapshot,
  perform,
  shownProblem,
  onDirtyChange,
  onBusyChange,
  presentation = "settings",
  edit,
  change,
}: {
  snapshot: DesktopSnapshot;
  edit?: string[] | null;
  change?(value: string[] | null): void;
  presentation?: "settings" | "setup";
  onDirtyChange?(dirty: boolean): void;
  onBusyChange?(busy: boolean): void;
  perform(action: DesktopAction): Promise<boolean>;
  shownProblem: DesktopProblem | null;
}) {
  // GitHub's own facts come from the connector catalog, which is the single
  // place any screenshot of this page can read them from.
  const githubStatus = githubStatusOf(snapshot.connectorCatalog);
  const githubAccount = githubAccountOf(snapshot.connectorCatalog);
  const githubProblem = githubProblemOf(snapshot.connectorCatalog);
  // Both the grant and project selection belong to this Bot.
  const projects = githubProjectsOf(snapshot.connectorCatalog);
  const setup = presentation === "setup";
  const [editing, setEditing] = useState(false);
  const {
    input: searchInput,
    entry: editButton,
    requestFocus,
  } = useConnectorEditorFocus();
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [localDraft, setLocalDraft] = useState<string[] | null>(null);
  const draft = edit === undefined ? localDraft : edit;
  const setDraft = change ?? setLocalDraft;
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const authorizing = githubStatus === "authorizing";
  const busy = snapshot.busy !== null || saving;
  const syncLabel =
    saving || snapshot.busy === "selectProjects" ? "正在保存项目选择…" : null;
  const idle =
    snapshot.setup !== "initializing" &&
    !["working", "organizingContext"].includes(snapshot.phase) &&
    (snapshot.queueDepth ?? 0) === 0;
  const available = snapshot.controlReady && githubStatus !== "authorizing";
  const issuerMissing = githubProblem === "issuer_not_configured";
  const selecting =
    setup && githubStatus === "connected" && projects.length > 0;
  // First-run setup has one primary-action form: the full-row invitation.
  const PrimaryAction = setup ? JourneyAction : Button;
  const selected =
    draft ??
    projects
      ?.filter((project) => project.selected)
      .map((project) => project.resourceId) ??
    [];
  const saved =
    projects
      ?.filter((project) => project.selected)
      .map((project) => project.resourceId) ?? [];
  const editorOpen = setup || editing || draft !== null || saved.length === 0;
  const dirty =
    draft !== null &&
    (selected.length !== saved.length ||
      selected.some((id) => !saved.includes(id)));
  useEffect(() => {
    onDirtyChange?.(!!dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (
      githubStatus === "authorizing" ||
      githubStatus === "disconnected" ||
      githubStatus === "reauthorization_required"
    )
      setDraft(null);
  }, [githubStatus, setDraft]);
  const visible = projects.filter((project) =>
    project.fullName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  async function save() {
    if (!dirty || busy || !available || !idle || githubStatus !== "connected")
      return;
    setSaving(true);
    onBusyChange?.(true);
    try {
      if (await perform({ type: "selectProjects", resourceIds: selected })) {
        if (!setup) requestFocus(selected.length === 0 ? "input" : "entry");
        setDraft(null);
        setSavedFeedback(true);
        // Retain the editor for an empty scope so a new choice stays one step away.
        setEditing(selected.length === 0);
      }
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  const connection = snapshot.connectorCatalog?.connections.find(
    (candidate) => candidate.providerId === "github",
  );
  const state = connectorState(connection, snapshot.connectorCatalog !== null);
  const searchField = (
    <div
      className={cn(
        "relative min-w-0 flex-1",
        setup &&
          "project-search @min-[740px]/presentation:col-start-2 @min-[740px]/presentation:row-start-1",
      )}
    >
      <Glyph
        name="search"
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
      />
      <input
        ref={searchInput}
        aria-label="查找 GitHub 项目"
        placeholder="查找项目"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="field-focus h-9 w-full rounded-md border border-field-border bg-field pr-3 pl-8 text-sm"
      />
    </div>
  );
  const choices = (
    <ul
      aria-label="可选项目"
      className={cn(
        "list-none divide-y divide-hairline/60 overflow-y-auto overscroll-contain",
        setup
          ? "project-choices max-h-[176px] @min-[740px]/presentation:col-span-3 @min-[740px]/presentation:max-h-[132px]"
          : "max-h-[264px]",
      )}
    >
      {visible.map((project) => (
        <li
          key={project.resourceId}
          className="project-choice flex items-center gap-3 py-3"
        >
          <Checkbox.Root
            id={`project-${project.resourceId}`}
            checked={selected.includes(project.resourceId)}
            disabled={busy || !available || githubStatus !== "connected"}
            aria-labelledby={`project-name-${project.resourceId}`}
            aria-describedby={`project-access-${project.resourceId}`}
            onCheckedChange={(checked) => {
              setSavedFeedback(false);
              setDraft(
                checked
                  ? [...selected, project.resourceId]
                  : selected.filter((id) => id !== project.resourceId),
              );
            }}
            className="grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-[5px] border border-control-boundary bg-card text-action data-checked:border-action/40 data-checked:bg-action-soft data-disabled:cursor-default data-disabled:opacity-50 field-focus"
          >
            <Checkbox.Indicator>
              <Glyph name="check" size={14} />
            </Checkbox.Indicator>
          </Checkbox.Root>
          {project.ownerId !== null && (
            <GitHubOwnerAvatar ownerId={project.ownerId} small />
          )}
          <label
            htmlFor={`project-${project.resourceId}`}
            className={cn(
              "min-w-0 flex-1 cursor-pointer",
              setup &&
                "@min-[740px]/presentation:flex @min-[740px]/presentation:items-baseline @min-[740px]/presentation:justify-between @min-[740px]/presentation:gap-4",
            )}
          >
            <span
              id={`project-name-${project.resourceId}`}
              dir="ltr"
              className="block text-sm font-medium [overflow-wrap:anywhere]"
            >
              {project.fullName}
            </span>
            <span
              id={`project-access-${project.resourceId}`}
              className={cn(
                "mt-0.5 block text-[11px] text-muted",
                setup &&
                  "@min-[740px]/presentation:mt-0 @min-[740px]/presentation:shrink-0",
              )}
            >
              {projectAccessLabel(project)}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
  const saveFooter = (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3",
        setup && "project-save @min-[740px]/presentation:col-span-3",
      )}
    >
      <p className="text-xs text-muted" role="status">
        {saving
          ? "正在保存…"
          : dirty
            ? `已勾选 ${selected.length} 个 · 尚未保存`
            : `已选择 ${saved.length} 个项目`}
      </p>
      <div className="flex items-center gap-2">
        {!setup && (
          <Button
            variant="text"
            className="m-0 text-xs"
            disabled={busy}
            onClick={() => {
              requestFocus(saved.length === 0 ? "input" : "entry");
              setDraft(null);
              setSearch("");
              setEditing(false);
            }}
          >
            {dirty ? "放弃更改" : "完成"}
          </Button>
        )}
        <PrimaryAction
          variant="primary"
          className={setup ? "min-h-11 w-auto gap-4 border-0 pt-0" : "text-xs"}
          disabled={
            !dirty ||
            busy ||
            !available ||
            !idle ||
            githubStatus !== "connected"
          }
          type="submit"
        >
          保存项目选择
        </PrimaryAction>
      </div>
    </div>
  );
  const authorizationControls = issuerMissing ? (
    <p className="text-xs leading-relaxed text-muted">
      这份 Mochi 的 GitHub 登录还没有准备完成。无需你填写密钥或安装工具。
    </p>
  ) : authorizing ? (
    <div className="space-y-3">
      {/* First-run setup already says this in its heading. */}
      {!setup && (
        <p role="status" className="text-xs text-muted">
          去 GitHub 确认授权，完成后这里会显示结果。
        </p>
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-2",
          setup && "flex-col items-stretch gap-1",
        )}
      >
        <PrimaryAction
          variant="primary"
          disabled={busy || !snapshot.canReopenGitHubLogin}
          onClick={() => void perform({ type: "reopenGitHubLogin" })}
        >
          继续 GitHub 授权
        </PrimaryAction>
        <Button
          variant="text"
          className="m-0 self-start text-muted"
          disabled={busy || !snapshot.controlReady}
          onClick={() => void perform({ type: "cancelGitHubLogin" })}
        >
          取消授权
        </Button>
      </div>
    </div>
  ) : githubStatus !== "connected" ? (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">
        {state === "reauthorization_required"
          ? "GitHub 授权已失效，请重新授权后继续访问。"
          : state === "unavailable" || state === "unknown"
            ? "暂时无法确认 GitHub 连接，Mochi 会自动重试。"
            : "使用你的 GitHub 账号登录，并为 Mochi 授权指定项目。组织项目可能需要管理员批准。"}
      </p>
      {state !== "unknown" && !(state === "unavailable" && githubAccount) && (
        <PrimaryAction
          variant="primary"
          disabled={busy || !available || !idle}
          onClick={() => void perform({ type: "loginGitHub" })}
        >
          {state === "reauthorization_required"
            ? "重新授权 GitHub"
            : "连接 GitHub"}
        </PrimaryAction>
      )}
    </div>
  ) : null;
  const collection =
    projects.length > 0 ? (
      <>
        {searchField}
        {choices}
        {visible.length === 0 && (
          <p
            role="status"
            className="project-empty col-span-3 py-5 text-center text-xs text-muted"
          >
            没有匹配的项目。
          </p>
        )}
        {saveFooter}
      </>
    ) : (
      <div className="rounded-lg border border-hairline px-4 py-4">
        <h3 className="text-sm">还没有可选项目</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          在 GitHub 为 Mochi
          授权指定项目，回到这里就会看到它们。组织项目可能需要管理员批准。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy || !snapshot.controlReady}
            onClick={() => void perform({ type: "manageGitHubAccess" })}
            size="small"
          >
            去 GitHub 选择项目
            <Glyph name="external" size={12} />
          </Button>
        </div>
      </div>
    );
  const error = shownProblem && (
    <p className={inlineError} role="alert">
      {shownProblem.message}
    </p>
  );
  const syncStatus = syncLabel && (
    <p
      role="status"
      className="inline-flex items-center gap-1.5 text-xs text-muted"
    >
      <Glyph name="spinner" size={14} spin />
      {syncLabel}
    </p>
  );

  if (!setup)
    return (
      <ConnectorDetailPage
        label="GitHub"
        icon="github"
        description="项目上下文与团队协作"
        identity={
          githubAccount
            ? `@${githubAccount.login}`
            : state === "unknown"
              ? "账号身份暂未确认"
              : "尚未连接账号"
        }
        status={connectorStatusOf(
          connection,
          snapshot.connectorCatalog !== null,
          "github",
        )}
        recovery={
          (authorizationControls ||
            (githubStatus !== "connected" && error)) && (
            <>
              {authorizationControls}
              {githubStatus !== "connected" && error}
            </>
          )
        }
      >
        {githubStatus === "connected" && (
          <ConnectorSection
            id="github-access"
            title="访问范围"
            description={
              editorOpen
                ? "勾选并保存后生效；取消选择会停止后续访问。"
                : `已选择 ${saved.length} 个项目`
            }
            aside={
              !editorOpen ? (
                <Button
                  ref={editButton}
                  size="small"
                  disabled={busy || !available}
                  onClick={() => {
                    requestFocus("input");
                    setEditing(true);
                    setSavedFeedback(false);
                  }}
                >
                  管理访问范围
                </Button>
              ) : null
            }
          >
            {editorOpen ? (
              <form
                data-settings-primary
                className="settings-card space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                {syncStatus}
                {collection}
                {!idle && (
                  <p role="status" className="text-xs text-muted">
                    可以先勾选项目，当前工作完成后再保存。
                  </p>
                )}
              </form>
            ) : (
              <>
                <SettingsList label="已选择项目" scroll>
                  {projects
                    .filter((project) => project.selected)
                    .map((project) => (
                      <SettingsRow
                        key={project.resourceId}
                        leading={
                          project.ownerId !== null ? (
                            <GitHubOwnerAvatar ownerId={project.ownerId} />
                          ) : (
                            <Avatar
                              src={null}
                              placeholder={<Glyph name="folder" size={20} />}
                            />
                          )
                        }
                        title={<span dir="ltr">{project.fullName}</span>}
                        detail={projectAccessLabel(project)}
                      />
                    ))}
                </SettingsList>
                {savedFeedback && (
                  <p role="status" className="text-xs text-status-good">
                    访问范围已保存。
                  </p>
                )}
                {syncStatus}
              </>
            )}
            {error}
            <ConnectorOperations connection={connection} />
          </ConnectorSection>
        )}
        <ConnectorManagement>
          <p>
            {authorizationMethodLabel(connectorAuthorizationFor("github"))} ·
            登录确认身份，项目授权决定可选范围。组织授权可能需要管理员批准。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={busy || !snapshot.controlReady || issuerMissing}
              onClick={() => void perform({ type: "manageGitHubAccess" })}
            >
              调整项目授权
              <Glyph name="external" size={12} />
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                void perform({ type: "reviewGitHubAuthorization" })
              }
            >
              查看或撤销账号授权
              <Glyph name="external" size={12} />
            </Button>
          </div>
          <p>
            支持读取代码、PR 与工作流，按团队授权协作 Issue。Issue 操作显示为
            Mochi Companion [bot]，同时记录实际请求者。
          </p>
          {githubAccount && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
              <p>断开连接会停止后续项目访问，已有对话保留。</p>
              <Button
                size="small"
                className="text-error"
                disabled={busy || !available || !idle}
                onClick={() => void perform({ type: "disconnectGitHub" })}
              >
                断开连接…
              </Button>
            </div>
          )}
          {!idle && <p>当前工作完成后，可以更换或断开连接。</p>}
        </ConnectorManagement>
      </ConnectorDetailPage>
    );

  return (
    <form
      className={cn(
        "setup-projects space-y-3",
        selecting &&
          "@min-[740px]/presentation:grid @min-[740px]/presentation:grid-cols-[minmax(0,1fr)_minmax(120px,172px)_auto] @min-[740px]/presentation:items-center @min-[740px]/presentation:gap-x-4 @min-[740px]/presentation:gap-y-2.5 @min-[740px]/presentation:space-y-0",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-3",
          selecting && "@min-[740px]/presentation:contents",
        )}
      >
        <div className="project-account min-w-0">
          <h3
            className={githubAccount ? "[overflow-wrap:anywhere]" : "sr-only"}
          >
            {githubAccount ? `@${githubAccount.login}` : "连接工作项目"}
          </h3>
          {syncStatus}
        </div>
      </div>
      {error}
      {authorizationControls}
      {githubStatus === "connected" && collection}
      {githubAccount && !authorizing && (
        <Button
          className="project-help col-span-3 m-0 inline-flex items-center gap-1.5 justify-self-start px-0 text-muted"
          variant="text"
          disabled={busy}
          onClick={() => void perform({ type: "manageGitHubAccess" })}
        >
          找不到项目？调整 GitHub 授权 <Glyph name="external" size={14} />
        </Button>
      )}
      <div className="project-note col-span-3 space-y-2 text-sm leading-[1.75] text-muted @min-[740px]/presentation:text-xs">
        <p>
          只访问你选中的项目，按团队授权管理 Issue。不会修改代码、PR 或工作流。
        </p>
        <details className="group/access">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-xs control-focus [&::-webkit-details-marker]:hidden">
            Issue 操作如何记录
            <Glyph
              name="chevronDown"
              size={12}
              className="group-open/access:rotate-180"
            />
          </summary>
          <p className="max-w-[42em] pt-1 text-xs">
            GitHub 会把 Issue 操作显示为 Mochi Companion [bot]；Mochi
            仍记录是谁提出和确认。
          </p>
        </details>
        {!idle && <p>当前工作完成后，就可以更换连接或调整项目。</p>}
      </div>
    </form>
  );
}
