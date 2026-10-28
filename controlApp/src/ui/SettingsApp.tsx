import { QueryClientProvider } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import manifest from "../../../motion/manifest.json";
import { MotionCatalog } from "../motion/catalog.ts";
import {
  BUILTIN_SKILLS,
  isByokAccountSummary,
  parseModelReference,
} from "../shared/bridge.ts";
import { githubAccountOf } from "../shared/connectorView.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { initialSnapshot } from "../shared/model.ts";
import {
  type DesktopProblem,
  problem,
  reconcileActionProblem,
} from "../shared/problem.ts";
import {
  SETTINGS_SECTIONS,
  type SettingsRoute,
  type SettingsSection,
  settingsSection,
} from "../shared/settings.ts";
import {
  botDisplayLabel,
  NAMES,
  NOT_RUNNING,
  PHASE_WORDS,
} from "../shared/vocabulary.ts";
import { AccountSettings } from "./AccountSettings.tsx";
import { accountPresentation } from "./accountPresentation.ts";
import { BotDutySwitch } from "./BotDutySwitch.tsx";
import { BotIdentitySettings } from "./BotIdentitySettings.tsx";
import { BotPortrait, rosterStatus } from "./BotSwitcher.tsx";
import { ConnectionRow } from "./ConnectionRow.tsx";
import { ConnectorsSettings } from "./ConnectorsSettings.tsx";
import { Button, StatusDot, StatusMark } from "./Controls.tsx";
import { bindProductConnection } from "./connection.ts";
import { connectionStatus } from "./connectionStatus.ts";
import { DiagnosticsSettings } from "./DiagnosticsSettings.tsx";
import {
  FeishuConnectionPanel,
  useFeishuApprovalWatch,
} from "./FeishuConnection.tsx";
import { FeishuMailSettings } from "./FeishuMailSettings.tsx";
import { FeishuServicesSettings } from "./FeishuServicesSettings.tsx";
import { Glyph } from "./Glyph.tsx";
import { GroupsSettings } from "./GroupsSettings.tsx";
import { HelpSettings } from "./HelpSettings.tsx";
import type { InstructionDraft } from "./InstructionsSettings.tsx";
import { InstructionsSettings } from "./InstructionsSettings.tsx";
import {
  MethodList,
  MethodReader,
  type MethodReadingState,
  methodIcons,
} from "./Methods.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { ProjectsSettings } from "./ProjectsSettings.tsx";
import { createDesktopQueries } from "./queries.ts";
import { SchedulesSettings } from "./SchedulesSettings.tsx";
import { SettingsIcon, type SettingsIconName } from "./SettingsIcon.tsx";
import { SettingsSectionHeader } from "./SettingsSectionHeader.tsx";
import type { SettingsConnection } from "./settingsConnection.ts";
import { cn } from "./styles.ts";
import { UpdateSettings } from "./UpdateSettings.tsx";

const catalog = new MotionCatalog(manifest);
const icons = {
  instructions: "profile",
  connectors: "connectors",
  model: "model",
  groups: "groups",
  schedules: "schedules",
} satisfies Record<SettingsSection, SettingsIconName>;
const applicationSections = {
  account: { label: "模型连接", icon: "account" },
  diagnostics: { label: "运行诊断", icon: "diagnostics" },
  about: { label: "关于与更新", icon: "general" },
  help: { label: "使用帮助", icon: "help" },
} as const;
function applicationRoute(route: SettingsRoute): boolean {
  return (
    route.page in applicationSections ||
    (route.page === "document" && route.section === "help")
  );
}
type Destination = { route: SettingsRoute; history: SettingsRoute[] };
type SettingsCategory = SettingsSection | keyof typeof applicationSections;
const rootRoutes = new Set([
  "instructions",
  "connectors",
  "model",
  "groups",
  "schedules",
  "account",
  "diagnostics",
  "about",
  "help",
]);
const readingFrame = "settings-content";
const readingPage = `${readingFrame} @container/settings pb-8 [&[hidden]]:hidden`;
/**
 * Titles for pages that have no chrome of their own. A connector detail page
 * draws its own heading and breadcrumb, because a connector's resources are a
 * child of the connector category rather than a peer of it.
 */
const titles: Partial<Record<SettingsRoute["page"], string>> = {
  instructions: "设定",
  connectors: "连接器",
  model: "模型",
  account: "模型连接",
  groups: "在群里一起工作",
  schedules: "安排",
  feishu: "群聊连接",
  diagnostics: "运行诊断",
  help: "Mochi 使用帮助",
  about: "关于与更新",
};
/** Child pages a back link can return to, named as their own titles read. */
const childLabels = {
  feishu: "群聊连接",
  feishuServices: "文档与知识库",
  feishuMail: "共享邮箱",
  projects: "GitHub",
} as const;
/** The place a back link returns to, in the words the reader last saw. */
function routeLabel(route: SettingsRoute): string {
  if (route.page === "document")
    return (
      BUILTIN_SKILLS.find((skill) => skill.id === route.id)?.name ?? "工作方法"
    );
  if (route.page in childLabels)
    return childLabels[route.page as keyof typeof childLabels];
  if (route.page in applicationSections)
    return applicationSections[route.page as keyof typeof applicationSections]
      .label;
  return SETTINGS_SECTIONS[route.page as SettingsSection].label;
}
function routeKey(route: SettingsRoute) {
  return route.page === "document"
    ? `${route.section}:${route.id}`
    : route.page;
}

/** One window owns its route, drafts and on-demand queries. Host facts are shared;
 * no settings state is persisted in the companion or inferred from its preview. */
export function SettingsApp({
  connection,
}: {
  connection: SettingsConnection;
}) {
  const [queries] = useState(createDesktopQueries);
  const botRoutes = useRef(new Map<string, Destination>());
  const applicationDestination = useRef<Destination>({
    route: { page: "account" },
    history: [],
  });
  const [store] = useState(() =>
    createStore<{
      snapshot: DesktopSnapshot;
      route: SettingsRoute;
      received: boolean;
      connectionProblem: DesktopProblem | null;
    }>(() => ({
      snapshot: initialSnapshot("", false),
      route: { page: "instructions" },
      received: false,
      connectionProblem: null,
    })),
  );
  const { snapshot, route, received, connectionProblem } = useStore(store);
  const productConnection = useMemo(
    () => bindProductConnection(connection, snapshot.selectedBotId),
    [connection, snapshot.selectedBotId],
  );
  const [actionProblem, setActionProblem] = useState<DesktopProblem | null>(
    null,
  );
  const actionGeneration = useRef(0);
  const [dutyProblem, setDutyProblem] = useState<DesktopProblem | null>(null);
  const dutyGeneration = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, InstructionDraft | null>>(
    {},
  );
  const draft = snapshot.selectedBotId
    ? (drafts[snapshot.selectedBotId] ?? null)
    : null;
  const setDraft = (value: InstructionDraft | null) => {
    const id = snapshot.selectedBotId;
    if (id) setDrafts((previous) => ({ ...previous, [id]: value }));
  };
  const [applying, setApplying] = useState(false);
  const [modelDrafts, setModelDrafts] = useState<
    Record<string, { model: string; reasoningEffort: string } | null>
  >({});
  const [projectDrafts, setProjectDrafts] = useState<
    Record<string, string[] | null>
  >({});
  const [resourceDrafts, setResourceDrafts] = useState<Record<string, string>>(
    {},
  );
  const [nameDrafts, setNameDrafts] = useState<
    Record<string, string | undefined>
  >({});
  useEffect(() => {
    setNameDrafts((previous) => {
      const saved = snapshot.bots.filter(
        (bot) => previous[bot.botId]?.trim() === bot.label,
      );
      if (!saved.length) return previous;
      const next = { ...previous };
      for (const bot of saved) delete next[bot.botId];
      return next;
    });
  }, [snapshot.bots]);
  const [dirtyForms, setDirtyForms] = useState<Record<string, boolean>>({});
  const botKey = snapshot.selectedBotId ?? "none";
  const githubConnectionState = snapshot.connectorCatalog?.connections.find(
    (connection) => connection.providerId === "github",
  )?.status;
  const projectCatalogKnown =
    snapshot.connectorCatalog !== null &&
    githubConnectionState !== "unavailable";
  const projectKey = `${botKey}:${githubAccountOf(snapshot.connectorCatalog)?.id ?? "disconnected"}`;
  const markDirty = useCallback(
    (key: string, value: boolean) =>
      setDirtyForms((previous) =>
        previous[key] === value ? previous : { ...previous, [key]: value },
      ),
    [],
  );
  useEffect(() => {
    // Unknown transport/authority is not proof that the account changed.
    if (!projectCatalogKnown) return;
    // A different confirmed GitHub identity cannot inherit the previous account's selection draft.
    setDirtyForms((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([key]) =>
            !key.startsWith(`projects:${botKey}:`) ||
            key === `projects:${projectKey}`,
        ),
      ),
    );
    setProjectDrafts((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(
          ([key]) => !key.startsWith(`${botKey}:`) || key === projectKey,
        ),
      ),
    );
  }, [botKey, projectKey, projectCatalogKnown]);
  const modelDirty = Object.entries(dirtyForms).some(
    ([key, dirty]) => key.startsWith("model:") && dirty,
  );
  const projectsDirty = Object.entries(dirtyForms).some(
    ([key, dirty]) => key.startsWith("projects:") && dirty,
  );
  const [reading, setReading] = useState<Record<string, MethodReadingState>>(
    {},
  );
  const closeState = useRef({ dirty: false, busy: false });
  closeState.current = {
    dirty:
      Object.values(drafts).some(
        (entry) => entry !== null && entry.content !== entry.base.content,
      ) ||
      modelDirty ||
      projectsDirty ||
      Object.values(resourceDrafts).some((value) => value.trim().length > 0) ||
      snapshot.bots.some(
        (bot) =>
          nameDrafts[bot.botId] !== undefined &&
          nameDrafts[bot.botId]?.trim() !== bot.label,
      ),
    busy: applying || (snapshot.busy !== null && snapshot.busy !== "uninstall"),
  };
  const history = useRef<SettingsRoute[]>([]);
  const destinations = useRef(new Map<SettingsCategory, Destination>());
  const content = useRef<HTMLElement>(null);
  const positions = useRef(
    new Map<string, { scroll: number; focus: string | null }>(),
  );
  const restore = useRef(false);
  const scrollSurface = useCallback(
    () =>
      content.current?.querySelector<HTMLElement>(
        ":scope > section:not([hidden]) [data-settings-scroll]",
      ) ?? content.current,
    [],
  );
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "s"
      )
        return;
      event.preventDefault();
      const visible = content.current?.querySelector(
        ":scope > section:not([hidden])",
      );
      const focusedForm = document.activeElement?.closest("form");
      const form =
        focusedForm && visible?.contains(focusedForm)
          ? focusedForm
          : (visible?.querySelector<HTMLFormElement>(
              "form[data-settings-primary]",
            ) ?? visible?.querySelector<HTMLFormElement>("form"));
      form?.requestSubmit();
    };
    document.addEventListener("keydown", save);
    return () => document.removeEventListener("keydown", save);
  }, []);
  const rememberPosition = () => {
    positions.current.set(routeKey(route), {
      scroll: scrollSurface()?.scrollTop ?? 0,
      focus: document.activeElement?.getAttribute("data-route-focus") ?? null,
    });
  };
  const navigate = (next: SettingsRoute, back = false) => {
    rememberPosition();
    actionGeneration.current++;
    setActionProblem(null);
    if (!back) {
      if (rootRoutes.has(next.page)) history.current = [];
      else history.current.push(route);
    }
    restore.current = back;
    const destination = { route: next, history: [...history.current] };
    if (applicationRoute(next)) applicationDestination.current = destination;
    else if (snapshot.selectedBotId)
      botRoutes.current.set(snapshot.selectedBotId, destination);
    store.setState({ route: next });
    void connection
      .rememberRoute(next)
      .catch(() =>
        store.setState({ connectionProblem: problem("control_unavailable") }),
      );
  };
  const openSharedAccount = () => {
    history.current = [route];
    navigate({ page: "account" }, true);
  };
  const switchSection = (section: SettingsCategory) => {
    const current = applicationRoute(route)
      ? route.page === "document"
        ? "help"
        : (route.page as keyof typeof applicationSections)
      : settingsSection(route);
    if (current === section) {
      // A connector's resources are a child route. Selecting the sidebar
      // category must always return to the connector overview so the category
      // remains a stable entry point instead of silently reopening a resource.
      if (
        section === "connectors" &&
        route.page !== "connectors" &&
        !applicationRoute(route)
      )
        navigate({ page: "connectors" }, true);
      return;
    }
    if (current)
      destinations.current.set(current, {
        route,
        history: [...history.current],
      });
    const previous =
      section === "connectors" ? undefined : destinations.current.get(section);
    history.current = previous?.history ? [...previous.history] : [];
    navigate(previous?.route ?? { page: section }, true);
  };
  useLayoutEffect(() => {
    if (!content.current) return;
    const position = positions.current.get(routeKey(route));
    const surface = scrollSurface();
    if (surface)
      surface.scrollTop = restore.current ? (position?.scroll ?? 0) : 0;
    const target =
      restore.current && position?.focus
        ? Array.from(
            content.current.querySelectorAll<HTMLElement>("[data-route-focus]"),
          ).find((element) => element.dataset.routeFocus === position.focus)
        : content.current.querySelector<HTMLElement>(
            "section:not([hidden]) h1, section:not([hidden]) h2, article h1",
          );
    target?.focus({ preventScroll: true });
    restore.current = false;
  }, [route, scrollSurface]);
  useEffect(() => {
    let active = true;
    const offClose = connection.onCloseState(() => closeState.current);
    const unsubscribe = connection.subscribe((frame) => {
      if (!active) return;
      const previous = store.getState();
      if (frame.navigation) {
        if (routeKey(frame.navigation) !== routeKey(previous.route))
          history.current = [];
        actionGeneration.current++;
        setActionProblem(null);
      } else
        setActionProblem((current) =>
          reconcileActionProblem(current, frame.snapshot),
        );
      const previousId = previous.snapshot.selectedBotId;
      setDutyProblem((current) =>
        reconcileActionProblem(current, frame.snapshot),
      );
      const switched =
        previous.received && previousId !== frame.snapshot.selectedBotId;
      if (switched) {
        actionGeneration.current++;
        dutyGeneration.current++;
        setDutyProblem(null);
        history.current = frame.navigation
          ? []
          : [
              ...(botRoutes.current.get(frame.snapshot.selectedBotId ?? "")
                ?.history ?? []),
            ];
        destinations.current.clear();
        positions.current.clear();
        setActionProblem(null);
      }
      const nextRoute =
        frame.navigation ??
        (switched
          ? (botRoutes.current.get(frame.snapshot.selectedBotId ?? "")
              ?.route ?? {
              page: "instructions",
            })
          : previous.route);
      const destination: Destination = {
        route:
          !frame.snapshot.selectedBotId && !applicationRoute(nextRoute)
            ? { page: "account" }
            : nextRoute,
        history: [...history.current],
      };
      if (applicationRoute(destination.route))
        applicationDestination.current = destination;
      else if (frame.snapshot.selectedBotId)
        botRoutes.current.set(frame.snapshot.selectedBotId, destination);
      store.setState({
        route: destination.route,
        snapshot: frame.snapshot,
        received: true,
        connectionProblem: null,
      });
    });
    void connection.ready().catch(() => {
      if (active)
        store.setState({ connectionProblem: problem("control_unavailable") });
    });
    return () => {
      active = false;
      offClose();
      unsubscribe();
      queries.clear();
    };
  }, [connection, store, queries]);
  useLayoutEffect(() => {
    if (!received) return;
    // A hidden WKWebView suspends animation frames. The static surface is ready
    // after React's fact-backed commit, synchronous layout, and local fonts;
    // it must not wait for a clock that starts only once the host shows it.
    let active = true;
    const element = content.current;
    if (!element || element.getBoundingClientRect().width <= 0) return;
    void document.fonts.ready
      .then(async () => {
        if (active) await connection.rendered();
      })
      .catch(() => {
        if (active)
          store.setState({ connectionProblem: problem("control_unavailable") });
      });
    return () => {
      active = false;
    };
  }, [received, connection, store]);
  const accountIdentity =
    snapshot.account.status === "unknown"
      ? undefined
      : JSON.stringify(snapshot.account);
  const catalogAccount = useRef(accountIdentity);
  useEffect(() => {
    if (
      accountIdentity === undefined ||
      accountIdentity === catalogAccount.current
    )
      return;
    catalogAccount.current = accountIdentity;
    void queries.resetQueries({ queryKey: ["model-catalog"] });
  }, [accountIdentity, queries]);
  useEffect(() => {
    if (!snapshot.controlReady)
      void queries.resetQueries({ queryKey: ["skill-catalog"] });
  }, [snapshot.controlReady, queries]);
  const perform = useCallback(
    async (action: DesktopAction) => {
      // The common duty control keeps its own failure, so an action taken on
      // the page beside it cannot replace it.
      const duty = action.type === "setBotEnabled";
      const generations = duty ? dutyGeneration : actionGeneration;
      const setProblem = duty ? setDutyProblem : setActionProblem;
      const generation = ++generations.current;
      setProblem(null);
      try {
        const result = await productConnection.perform(action);
        if (!result.ok && generation === generations.current)
          setProblem(
            reconcileActionProblem(result.problem, store.getState().snapshot),
          );
        return result.ok;
      } catch {
        if (generation === generations.current)
          setProblem(problem("control_unavailable"));
        return false;
      }
    },
    [productConnection, store],
  );
  const act = useCallback(
    async (action: DesktopAction) => {
      await perform(action);
    },
    [perform],
  );
  // Only a visible Feishu page watches for an administrator's approval.
  const approval = useFeishuApprovalWatch(
    snapshot,
    perform,
    route.page === "groups" || route.page === "feishu",
  );
  const selected = settingsSection(route);
  const appScope = applicationRoute(route);
  const selectedBot = snapshot.bots.find(
    (bot) => bot.botId === snapshot.selectedBotId,
  );
  const revealSelectedCategory = useCallback(
    (button: HTMLButtonElement | null) => {
      button?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    },
    [],
  );
  const selectBot = (botId: string, destination?: SettingsRoute) => {
    const target = destination
      ? { route: destination, history: [] }
      : (botRoutes.current.get(botId) ?? {
          route: { page: "instructions" } as const,
          history: [],
        });
    botRoutes.current.set(botId, target);
    if (botId === snapshot.selectedBotId) {
      history.current = [...target.history];
      navigate(target.route, true);
    } else void act({ type: "selectBot", botId });
  };
  const pageProblem = connectionProblem ?? actionProblem;
  const shownProblem =
    (!appScope && dutyProblem) ||
    route.page === "projects" ||
    route.page === "feishuServices" ||
    route.page === "feishuMail" ||
    (route.page === "groups" && snapshot.feishu.active)
      ? null
      : pageProblem;
  const busy = useVisibleBusy(snapshot.busy !== null || applying);
  /** Where a page without history returns: its category's overview. */
  const parent: SettingsRoute = {
    page: appScope ? "help" : (selected ?? "instructions"),
  };
  const heading = (id: SettingsRoute["page"]) =>
    titles[id] && (
      <header className="mb-8 shrink-0">
        <h1
          tabIndex={-1}
          className="text-display font-semibold tracking-[-0.02em] outline-none"
        >
          {titles[id]}
        </h1>
      </header>
    );
  const backLabel = routeLabel(history.current.at(-1) ?? parent);
  /**
   * A child page's way back is part of its title: a chevron that hangs in the
   * margin beside the title, so the title keeps the reading axis and both read
   * as one line. Narrow windows have no margin to hang in, so the chevron and
   * its destination sit above the title instead.
   */
  const back = (!rootRoutes.has(route.page) || history.current.length > 0) && (
    <button
      type="button"
      aria-label={`返回 ${backLabel}`}
      title={`返回${backLabel}`}
      onClick={() => navigate(history.current.pop() ?? parent, true)}
      className="absolute top-0.5 right-full mr-1 flex size-8 cursor-pointer items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-ink/5 hover:text-ink motion-reduce:transition-none control-focus max-[899px]:static max-[899px]:mb-3 max-[899px]:-ml-1.5 max-[899px]:w-auto max-[899px]:gap-0.5 max-[899px]:rounded-md max-[899px]:pr-2.5 max-[899px]:pl-0.5 max-[899px]:text-sm max-[899px]:font-medium max-[899px]:text-ink"
    >
      <Glyph name="chevronLeft" size={18} />
      <span className="hidden max-[899px]:inline">{backLabel}</span>
    </button>
  );
  const page = (
    id: SettingsRoute["page"],
    children: ReactNode,
    className?: string,
  ) => (
    <section
      hidden={route.page !== id}
      className={cn(
        id === "instructions" ? "w-full [&[hidden]]:hidden" : readingPage,
        className,
      )}
    >
      {id === "instructions" ? (
        children
      ) : (
        <div className="relative">
          {route.page === id && back}
          {heading(id)}
          {children}
        </div>
      )}
    </section>
  );
  /** One 伙伴 has no roster to choose from; its column and the shared one merge. */
  const merged = snapshot.bots.length <= 1;
  const addCompanion = `新增${NAMES.companion}`;
  const category = (
    key: SettingsCategory,
    label: string,
    icon: SettingsIconName,
    active: boolean,
  ) => (
    <button
      key={key}
      ref={active ? revealSelectedCategory : undefined}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => switchSection(key)}
      className={cn(
        "flex min-h-9 min-w-0 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-left text-sm text-muted transition-colors duration-150 hover:bg-ink/4 hover:text-ink motion-reduce:transition-none max-[579px]:px-2 whitespace-nowrap control-focus",
        active &&
          "bg-settings-selection font-medium text-settings-selected hover:bg-settings-selection",
      )}
    >
      <SettingsIcon name={icon} />
      {label}
      {key === "about" &&
        snapshot.setup === null &&
        ["available", "ready"].includes(snapshot.update.phase) && (
          <span
            className="ml-auto size-1.5 shrink-0 rounded-full bg-settings-selected"
            role="img"
            aria-label="有新版本"
          />
        )}
    </button>
  );
  const botCategories = Object.entries(SETTINGS_SECTIONS).map(([key, item]) =>
    category(
      key as SettingsSection,
      item.label,
      icons[key as SettingsSection],
      !appScope && selected === key,
    ),
  );
  const applicationCategories = Object.entries(applicationSections).map(
    ([key, item]) =>
      category(
        key as keyof typeof applicationSections,
        item.label,
        item.icon,
        appScope && (route.page === "document" ? "help" : route.page) === key,
      ),
  );
  const identityStatus = !snapshot.loaded
    ? NOT_RUNNING
    : !snapshot.controlReady
      ? PHASE_WORDS.checking
      : snapshot.setup === "initializing"
        ? PHASE_WORDS.starting
        : selectedBot
          ? rosterStatus(selectedBot, snapshot)
          : null;
  /** The 伙伴 being set up: name, live status and its duty switch, at F1. */
  const identity = (
    <section
      aria-label={`当前${NAMES.companion}`}
      className={cn("mb-[18.5px] max-[579px]:mb-2", merged ? "mx-0" : "mx-2.5")}
    >
      <div className="flex items-center gap-3 max-[579px]:min-h-8">
        {merged && selectedBot && (
          <BotPortrait
            bot={selectedBot}
            catalog={catalog}
            available={snapshot.controlReady}
            className="size-8 shrink-0 bg-transparent max-[579px]:hidden"
          />
        )}
        <div className="min-w-0 flex-1 max-[579px]:flex max-[579px]:items-baseline max-[579px]:gap-3">
          <p
            title={
              selectedBot
                ? botDisplayLabel(selectedBot, snapshot.bots)
                : undefined
            }
            className="truncate text-sm leading-5 font-semibold max-[579px]:min-w-0 max-[579px]:flex-1"
          >
            {selectedBot
              ? botDisplayLabel(selectedBot, snapshot.bots)
              : snapshot.controlReady
                ? `还没有${NAMES.companion}`
                : "Mochi"}
          </p>
          <p
            aria-live="polite"
            className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted max-[579px]:shrink-0 max-[579px]:whitespace-nowrap"
          >
            {identityStatus && (
              <StatusDot tone={identityStatus.tone} className="size-1.5" />
            )}
            <span className="truncate">
              {identityStatus?.label ?? "新增后就能设置"}
            </span>
          </p>
        </div>
        {selectedBot && (
          <BotDutySwitch bot={selectedBot} snapshot={snapshot} act={act} />
        )}
      </div>
      {dutyProblem && (
        <p role="alert" className="mt-3 text-xs leading-relaxed text-error">
          {dutyProblem.title}。{dutyProblem.message}
        </p>
      )}
    </section>
  );
  return (
    <QueryClientProvider client={queries}>
      <div className="settings-theme relative flex h-dvh min-w-0 bg-settings-chrome text-ink max-[579px]:flex-col [&_*]:tracking-normal">
        <div
          aria-hidden="true"
          className="electrobun-webkit-app-region-drag absolute inset-x-0 top-0 z-10 h-6 [-webkit-app-region:drag] max-[579px]:hidden"
        />
        {/* The column heads share one baseline with the page title (F1); the
            first entry of every column starts on F2, 133 pt, the first section
            rule of the reading panel. */}
        <header
          className={cn(
            "electrobun-webkit-app-region-drag absolute top-[77.5px] left-5 flex items-baseline gap-2 leading-5 whitespace-nowrap [-webkit-app-region:drag] max-[579px]:static max-[579px]:h-10 max-[579px]:shrink-0 max-[579px]:px-5 max-[579px]:pt-2",
            // A portrait strip is too narrow to carry the wordmark.
            !merged && "min-[580px]:max-[699px]:hidden",
          )}
        >
          <span className="font-brand text-lead leading-5 font-semibold">
            Mochi
          </span>
          <span className="text-xs leading-5 text-muted">设置</span>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 max-[579px]:flex-col">
          {merged ? (
            // One 伙伴: its categories and the shared ones share one column.
            <aside
              aria-label="设置范围"
              className="flex w-[208px] shrink-0 flex-col overflow-y-auto px-3 pt-[133px] pb-4 max-[899px]:w-[184px] max-[579px]:w-full max-[579px]:border-b max-[579px]:border-hairline max-[579px]:py-2"
            >
              {identity}
              {snapshot.selectedBotId && (
                <nav
                  aria-label="设置分类"
                  className="mt-3 flex flex-col gap-0.5 max-[579px]:mt-1 max-[579px]:flex-row max-[579px]:overflow-x-auto max-[579px]:p-1"
                >
                  {botCategories}
                </nav>
              )}
              <p className="mt-5 mb-1 px-2.5 text-xs leading-5 text-muted max-[579px]:hidden">
                通用
              </p>
              <nav
                aria-label="通用设置"
                className="flex flex-col gap-0.5 max-[579px]:flex-row max-[579px]:overflow-x-auto max-[579px]:p-1"
              >
                {applicationCategories}
              </nav>
              <button
                type="button"
                disabled={busy || !snapshot.controlReady}
                onClick={() => void act({ type: "createBot" })}
                className="mt-5 flex min-h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-left text-xs text-muted transition-colors duration-150 hover:bg-ink/4 hover:text-ink disabled:opacity-40 motion-reduce:transition-none control-focus max-[579px]:mt-1 max-[579px]:min-h-8 max-[579px]:self-start"
              >
                <span className="grid size-6 place-items-center">
                  <Glyph name="plus" size={14} />
                </span>
                {addCompanion}
              </button>
            </aside>
          ) : (
            <>
              <aside
                aria-label="设置范围"
                className="flex w-[148px] shrink-0 flex-col overflow-y-auto border-r border-hairline px-2 pt-[133px] pb-4 max-[899px]:w-[132px] min-[580px]:max-[699px]:w-14 min-[580px]:max-[699px]:items-center min-[580px]:max-[699px]:px-1.5 max-[579px]:w-full max-[579px]:flex-row max-[579px]:items-center max-[579px]:gap-2 max-[579px]:overflow-x-auto max-[579px]:border-r-0 max-[579px]:border-b max-[579px]:py-2"
              >
                <button
                  type="button"
                  aria-current={appScope ? "true" : undefined}
                  title="通用"
                  onClick={() => {
                    const destination = applicationDestination.current;
                    history.current = [...destination.history];
                    navigate(destination.route, true);
                  }}
                  className={cn(
                    "flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-transparent px-2 text-left text-sm font-medium text-muted hover:bg-ink/4 control-focus min-[580px]:max-[699px]:px-1",
                    appScope && "border-hairline bg-card/80 text-ink",
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center">
                    <SettingsIcon name="general" />
                  </span>
                  <span className="min-[580px]:max-[699px]:sr-only">通用</span>
                </button>
                <div className="mt-6 mb-1 flex min-h-7 items-center justify-between pl-2 text-xs text-muted min-[580px]:max-[699px]:justify-center min-[580px]:max-[699px]:pl-0 max-[579px]:contents">
                  <span className="min-[580px]:max-[699px]:sr-only max-[579px]:hidden">
                    {NAMES.companion}
                  </span>
                  <button
                    type="button"
                    aria-label={addCompanion}
                    title={addCompanion}
                    disabled={busy || !snapshot.controlReady}
                    onClick={() => void act({ type: "createBot" })}
                    className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-muted hover:bg-ink/5 hover:text-ink disabled:opacity-40 max-[579px]:order-last control-focus"
                  >
                    <Glyph name="plus" size={14} />
                  </button>
                </div>
                <div className="flex flex-col gap-1 max-[579px]:flex-row">
                  {snapshot.bots.map((bot) => {
                    const dirty =
                      (drafts[bot.botId] &&
                        drafts[bot.botId]!.content !==
                          drafts[bot.botId]!.base.content) ||
                      Object.entries(dirtyForms).some(
                        ([key, value]) => value && key.includes(bot.botId),
                      ) ||
                      (resourceDrafts[bot.botId]?.trim().length ?? 0) > 0 ||
                      (nameDrafts[bot.botId] !== undefined &&
                        nameDrafts[bot.botId]?.trim() !== bot.label);
                    const name = botDisplayLabel(bot, snapshot.bots);
                    const status = rosterStatus(bot, snapshot);
                    return (
                      <button
                        key={bot.botId}
                        type="button"
                        title={`${name} · ${status.label}`}
                        aria-label={`设置${name}`}
                        aria-current={
                          !appScope && bot.botId === botKey ? "true" : undefined
                        }
                        disabled={busy}
                        onClick={() => selectBot(bot.botId)}
                        className={cn(
                          "flex min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-md border border-transparent px-2 text-left text-sm font-medium text-muted hover:bg-ink/4 disabled:opacity-50 max-[579px]:max-w-40 min-[580px]:max-[699px]:px-1 control-focus",
                          !appScope &&
                            bot.botId === botKey &&
                            "border-hairline bg-card/80 text-ink",
                        )}
                      >
                        <span className="relative shrink-0">
                          <BotPortrait
                            bot={bot}
                            catalog={catalog}
                            available={snapshot.controlReady}
                            className="size-8 bg-transparent"
                          />
                          <StatusDot
                            tone={status.tone}
                            className="absolute -right-0.5 -bottom-0.5 ring-2 ring-surface"
                          />
                        </span>
                        <span className="truncate min-[580px]:max-[699px]:sr-only">
                          {name}
                        </span>
                        {dirty && (
                          <span
                            role="img"
                            aria-label="有未保存的修改"
                            className="ml-auto size-1.5 shrink-0 rounded-full bg-status-attention min-[580px]:max-[699px]:absolute min-[580px]:max-[699px]:ml-0"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </aside>
              <aside className="flex w-[184px] shrink-0 flex-col px-3 pt-[78.5px] pb-4 max-[899px]:w-[164px] max-[579px]:w-full max-[579px]:border-b max-[579px]:px-3 max-[579px]:py-2">
                {appScope ? (
                  <section
                    aria-label="通用设置"
                    className="mx-2.5 mb-[18.5px] max-[579px]:hidden"
                  >
                    <p className="truncate text-sm leading-5 font-semibold">
                      通用
                    </p>
                    <p className="text-xs leading-4 text-muted">
                      这台 Mac 上的共用设置
                    </p>
                  </section>
                ) : (
                  identity
                )}
                <nav
                  aria-label="设置分类"
                  className="flex flex-col gap-0.5 overflow-y-auto max-[579px]:flex-row max-[579px]:overflow-x-auto max-[579px]:p-1"
                >
                  {appScope ? applicationCategories : botCategories}
                </nav>
              </aside>
            </>
          )}
          <div
            data-testid="settings-reading-surface"
            className="my-2 mr-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-settings-page max-[579px]:mt-0 max-[579px]:ml-2"
          >
            <div
              className={`electrobun-webkit-app-region-drag ${readingFrame} flex h-10 shrink-0 items-center [-webkit-app-region:drag] max-[579px]:h-8`}
            ></div>
            {shownProblem && (
              <div className={`${readingFrame} mb-4`}>
                <p
                  role="alert"
                  className="rounded-md border border-error/25 bg-card px-4 py-3 text-sm leading-6 text-error"
                >
                  {shownProblem.title}。{shownProblem.message}
                </p>
              </div>
            )}
            <main
              ref={content}
              aria-label="设置内容"
              className={cn(
                "min-h-0 flex-1",
                route.page === "instructions"
                  ? "flex overflow-hidden"
                  : "settings-scroll",
              )}
            >
              {page(
                "instructions",
                <InstructionsSettings
                  introduction={
                    <>
                      {heading("instructions")}
                      <BotIdentitySettings
                        snapshot={snapshot}
                        busy={busy}
                        act={act}
                        nameDraft={nameDrafts[botKey]}
                        changeName={(value) =>
                          setNameDrafts((previous) => ({
                            ...previous,
                            [botKey]: value,
                          }))
                        }
                      />
                    </>
                  }
                  botName={
                    snapshot.bots.find(
                      (bot) => bot.botId === snapshot.selectedBotId,
                    )?.label ?? NAMES.companion
                  }
                  key={snapshot.selectedBotId}
                  active={route.page === "instructions"}
                  available={snapshot.controlReady}
                  busy={busy}
                  connection={productConnection}
                  draft={draft}
                  change={setDraft}
                  onBusyChange={setApplying}
                />,
                "flex min-h-0 flex-1 flex-col pb-0",
              )}
              {page(
                "connectors",
                <ConnectorsSettings snapshot={snapshot} navigate={navigate} />,
              )}
              {page(
                "schedules",
                <SchedulesSettings
                  key={snapshot.selectedBotId}
                  snapshot={snapshot}
                  connection={productConnection}
                  active={route.page === "schedules"}
                  onBusyChange={setApplying}
                />,
              )}
              {page(
                "model",
                <>
                  <SettingsSectionHeader title="来源" />
                  <button
                    type="button"
                    onClick={openSharedAccount}
                    className="group/source settings-grid min-h-10 w-full items-center gap-y-2 rounded-sm text-left control-focus"
                  >
                    <span className="settings-label">模型连接</span>
                    <span className="settings-value flex flex-wrap items-center gap-x-3 gap-y-1 text-sm leading-6">
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                        {modelSourceLabel(snapshot)}
                      </span>
                      <StatusMark
                        tone={
                          snapshot.account.status === "signedIn"
                            ? "good"
                            : "muted"
                        }
                      >
                        {accountPresentation[snapshot.account.status].status}
                      </StatusMark>
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted transition-colors duration-150 group-hover/source:text-ink motion-reduce:transition-none">
                        管理模型连接
                        <Glyph name="chevronRight" size={14} />
                      </span>
                    </span>
                  </button>
                  <div className="mt-10">
                    <SettingsSectionHeader title="模型与思考深度" />
                    {snapshot.account.status === "signedIn" ||
                    snapshot.account.status === "unknown" ? (
                      <ModelSettings
                        key={snapshot.selectedBotId}
                        snapshot={snapshot}
                        connection={productConnection}
                        active={route.page === "model"}
                        onBusyChange={setApplying}
                        edit={modelDrafts[botKey] ?? null}
                        change={(value) =>
                          setModelDrafts((previous) => ({
                            ...previous,
                            [botKey]: value,
                          }))
                        }
                        onDirtyChange={(dirty) =>
                          markDirty(`model:${botKey}`, dirty)
                        }
                      />
                    ) : (
                      <div className="space-y-4 text-sm leading-relaxed text-muted">
                        <p>连接模型后，就能选择模型与思考深度。</p>
                        <Button onClick={openSharedAccount}>
                          查看模型连接
                        </Button>
                      </div>
                    )}
                  </div>
                </>,
              )}
              {page(
                "account",
                <AccountSettings
                  snapshot={snapshot}
                  act={act}
                  shownProblem={null}
                  diagnose={() => navigate({ page: "diagnostics" })}
                />,
              )}
              {page(
                "groups",
                <>
                  <SettingsSectionHeader title="群聊连接" />
                  {snapshot.feishu.active?.state === "ready" &&
                  !snapshot.feishu.candidate ? (
                    <ConnectionRow
                      action="管理连接"
                      icon={methodIcons["feishu-collaboration"]}
                      title={snapshot.feishu.active.bot?.name ?? "群聊机器人"}
                      detail={connectionStatus(snapshot)}
                      onClick={() => navigate({ page: "feishu" })}
                    />
                  ) : (
                    <FeishuConnectionPanel
                      snapshot={approval.snapshot}
                      perform={perform}
                      watch={approval}
                    />
                  )}
                  <GroupsSettings
                    key={snapshot.selectedBotId}
                    snapshot={snapshot}
                    act={act}
                    busy={busy}
                    shownProblem={pageProblem}
                  />
                  <MethodList
                    title="协作约定"
                    ids={["feishu-collaboration", "message-contract"]}
                    navigate={(id) =>
                      navigate({ page: "document", id, section: "groups" })
                    }
                  />
                </>,
              )}
              {page(
                "feishu",
                <>
                  <SettingsSectionHeader title="群聊机器人" />
                  <FeishuConnectionPanel
                    snapshot={approval.snapshot}
                    perform={perform}
                    watch={approval}
                  />
                </>,
              )}
              {page(
                "feishuServices",
                <FeishuServicesSettings
                  key={botKey}
                  snapshot={snapshot}
                  perform={perform}
                  openConnection={() => navigate({ page: "feishu" })}
                  draft={resourceDrafts[botKey] ?? ""}
                  change={(value) =>
                    setResourceDrafts((previous) => ({
                      ...previous,
                      [botKey]: value,
                    }))
                  }
                  onBusyChange={setApplying}
                  shownProblem={connectionProblem ?? actionProblem}
                />,
              )}
              {page(
                "feishuMail",
                <FeishuMailSettings
                  key={botKey}
                  busy={busy}
                  snapshot={snapshot}
                  perform={perform}
                  openFeishu={() => navigate({ page: "feishu" })}
                  onBusyChange={setApplying}
                  shownProblem={connectionProblem ?? actionProblem}
                />,
              )}
              {page(
                "projects",
                <ProjectsSettings
                  key={`${snapshot.selectedBotId ?? "none"}:${githubAccountOf(snapshot.connectorCatalog)?.id ?? "disconnected"}`}
                  snapshot={snapshot}
                  perform={perform}
                  shownProblem={connectionProblem ?? actionProblem}
                  edit={projectDrafts[projectKey] ?? null}
                  change={(value) =>
                    setProjectDrafts((previous) =>
                      previous[projectKey] === value
                        ? previous
                        : { ...previous, [projectKey]: value },
                    )
                  }
                  onDirtyChange={(dirty) =>
                    markDirty(`projects:${projectKey}`, dirty)
                  }
                  onBusyChange={setApplying}
                />,
              )}
              {route.page === "document" && (
                <div className={`${readingFrame} pb-10`}>
                  <div className="relative">
                    {back}
                    <MethodReader
                      id={route.id}
                      connection={productConnection}
                      available={snapshot.controlReady}
                      busy={busy}
                      scrollContainer={content}
                      reading={
                        reading[route.id] ?? {
                          source: false,
                          readingScroll: 0,
                          sourceScroll: 0,
                        }
                      }
                      changeReading={(state) =>
                        setReading((previous) => ({
                          ...previous,
                          [route.id]: state,
                        }))
                      }
                      navigate={(id) =>
                        navigate({
                          page: "document",
                          id,
                          ...(route.section ? { section: route.section } : {}),
                        })
                      }
                    />
                  </div>
                </div>
              )}
              {page("help", <HelpSettings navigate={navigate} />)}
              {page("about", <UpdateSettings snapshot={snapshot} act={act} />)}
              {page(
                "diagnostics",
                <DiagnosticsSettings snapshot={snapshot} act={act} />,
              )}
            </main>
          </div>
        </div>
      </div>
    </QueryClientProvider>
  );
}

/** The model source this Bot's saved policy names; only a confirmed account can name it. */
function modelSourceLabel(snapshot: DesktopSnapshot): string {
  if (snapshot.account.status !== "signedIn" || !snapshot.policy?.model)
    return "查看共用连接";
  const provider = parseModelReference(snapshot.policy.model).provider;
  const source = snapshot.account.connections.find(
    (connection) => connection.provider === provider,
  );
  if (!source || !isByokAccountSummary(source)) return "ChatGPT";
  return source.label;
}

/**
 * A moment-long action (a toggle, a quick save) must not dim the whole window
 * and snap back. Controls show the busy state only once it has lasted 200 ms;
 * the host still serializes every action, so an early second click is refused
 * there, not raced. Close protection keeps reading the immediate state.
 */
function useVisibleBusy(busy: boolean, delayMilliseconds = 200): boolean {
  const [visible, setVisible] = useState(busy);
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMilliseconds);
    return () => clearTimeout(timer);
  }, [busy, delayMilliseconds]);
  return busy && visible;
}
