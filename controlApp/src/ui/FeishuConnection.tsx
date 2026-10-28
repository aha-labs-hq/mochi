import { useCallback, useEffect, useRef, useState } from "react";
import {
  FEISHU_CONNECTION_FAILURES,
  type FeishuConnectionFailure,
  LARK_PLATFORMS,
} from "../shared/bridge.ts";
import type { DesktopAction, DesktopSnapshot } from "../shared/model.ts";
import { companionName, zh } from "../shared/vocabulary.ts";
import { Button } from "./Controls.tsx";
import { Glyph } from "./Glyph.tsx";
import { GroupAvatar } from "./GroupAvatar.tsx";
import { JourneyAction } from "./JourneyAction.tsx";
import { cn } from "./styles.ts";

export function feishuPresentation(snapshot: DesktopSnapshot): {
  title: string;
  detail: string;
  note: string;
  action: { label: string; value: DesktopAction } | null;
} {
  const connection = snapshot.feishu;
  const candidate = connection.candidate;
  const name = companionName(snapshot);
  const brand = candidate ? candidate.brand : connection.active?.brand;
  const service = brand ? LARK_PLATFORMS[brand].name : "飞书 / Lark";
  if (candidate?.state === "registering")
    return {
      title: "用飞书或 Lark 扫码",
      detail: "打开你使用的聊天应用扫一扫，按提示完成连接。",
      note: connection.active
        ? "确认接入之前，当前机器人会继续使用。"
        : "组织权限可能需要管理员批准；扫码完成后，会在这里显示连接结果。",
      action: null,
    };
  if (
    candidate?.state === "checking" ||
    connection.active?.state === "checking"
  )
    return {
      title: "正在检查机器人",
      detail: "正在确认机器人的身份、群消息权限和发布状态。",
      note: "检查完成后，会在这里显示结果和下一步。",
      action: null,
    };
  if (candidate?.state === "ready")
    return {
      title: zh`确认你的${service}机器人`,
      detail: zh`连接已检查通过。确认使用后，${name}会通过这个机器人参与群聊。`,
      note: zh`名称和头像可以在${service}应用设置里调整。`,
      action: {
        label: connection.active ? "改用这个机器人" : "使用这个机器人",
        value: { type: "activateFeishuConnection" },
      },
    };
  if (candidate)
    return feishuProblemPresentation(candidate.problem, true, service);
  if (connection.active?.state === "unavailable") {
    const problem = activeFeishuProblem(snapshot);
    if (
      problem &&
      problem !== "provider_unavailable" &&
      problem !== "provider_response_invalid"
    )
      return feishuProblemPresentation(problem, false, service);
    // Feishu not answering needs nothing from the customer: Mochi rechecks.
    return {
      title: zh`暂时无法确认${service}连接`,
      detail: "原连接没有被替换。Mochi 会自动重试，确认后继续接收群消息。",
      note: "不能确认身份时，不会接收新的群消息。",
      action: null,
    };
  }
  if (connection.active?.state === "ready")
    return {
      title: connection.active.bot!.name,
      detail: zh`这是当前连接的${service}机器人。群聊中的名称和头像以${service}为准。`,
      note: "更换机器人不会丢掉长期记忆。",
      action: { label: "连接另一个机器人", value: { type: "connectFeishu" } },
    };
  return {
    title: "连接团队群聊",
    detail: zh`连接飞书或 Lark，让${name}以机器人的身份参与群聊。`,
    note: "下一步扫码确认。组织权限可能需要管理员批准。",
    action: { label: "开始连接", value: { type: "connectFeishu" } },
  };
}

function activeFeishuProblem(
  snapshot: DesktopSnapshot,
): FeishuConnectionFailure | null {
  const problem = snapshot.connectorCatalog?.connections.find(
    (connection) => connection.providerId === "feishu-service",
  )?.problem;
  return problem &&
    FEISHU_CONNECTION_FAILURES.includes(problem as FeishuConnectionFailure)
    ? (problem as FeishuConnectionFailure)
    : null;
}

function feishuProblemPresentation(
  problem: FeishuConnectionFailure | null,
  candidate: boolean,
  service: string,
): {
  title: string;
  detail: string;
  note: string;
  action: { label: string; value: DesktopAction } | null;
} {
  if (problem === "permissions_approval_required")
    return {
      title: zh`${service}权限尚未获批`,
      detail: zh`请把权限链接发给管理员，在${service}确认申请和审批状态。权限生效后，这里会自动检查。`,
      note: candidate
        ? "已创建的应用会保留，不会再创建一个机器人。"
        : "当前机器人没有被替换，批准后 Mochi 会自动确认。",
      action: {
        label: "复制权限链接",
        value: { type: "copyFeishuApprovalLink" },
      },
    };
  return {
    title:
      problem === "group_messages_required"
        ? "需要补充群消息权限"
        : problem === "permissions_required"
          ? zh`需要补充${service}权限`
          : problem === "publication_required"
            ? zh`需要完成${service}应用发布`
            : "继续完成连接",
    detail: feishuFailureCopy(problem, service),
    note: candidate
      ? "已创建的应用会保留。继续检查不会再创建一个机器人。"
      : "当前机器人没有被替换。完成这一步后回到 Mochi，它会自动确认。",
    // The working connection is rechecked on its own; only a replacement waits
    // for the customer to say a step in Feishu is done.
    action: needsAuthorization(problem)
      ? { label: zh`去${service}确认授权`, value: { type: "feishuSettings" } }
      : problem === "publication_required"
        ? { label: zh`去${service}确认发布`, value: { type: "feishuSettings" } }
        : candidate
          ? { label: "检查并继续", value: { type: "checkFeishuCandidate" } }
          : null,
  };
}

function needsAuthorization(code: FeishuConnectionFailure | null): boolean {
  return (
    code === "permissions_required" ||
    code === "permissions_approval_required" ||
    code === "group_messages_required"
  );
}

function feishuFailureCopy(
  code: FeishuConnectionFailure | null,
  service: string,
): string {
  switch (code) {
    case "bot_already_connected":
      return zh`这个${service}机器人已属于另一位伙伴。请为当前伙伴连接一个独立的${service}机器人。`;
    case "group_messages_required":
      return zh`${service}机器人还不能读取群里的后续消息。${service}官方授权页已带好所需权限，你只需确认申请；组织可能需要管理员审批。`;
    case "permissions_required":
      return zh`${service}还没有授予完整权限。官方授权页会带入需要补充的权限，请确认申请；如果${service}要求发布或管理员审批，需等它生效后继续。`;
    case "publication_required":
      return zh`应用还没发布或启用。请在${service}完成发布，再回来继续。`;
    case "registration_expired":
      return "本次二维码已过期。如果你已经创建了应用，先检查连接，不要重复创建。";
    case "registration_cancelled":
      return zh`本次扫码已暂停。若${service}已创建了应用，可以继续检查并接入它。`;
    case "credential_unavailable":
      return zh`${service}还没有交付机器人连接信息。请先完成之前的${service}确认，再检查连接。`;
    case "identity_changed":
      return zh`${service}返回的身份与这次连接不一致。为避免接错机器人，已停止接入。`;
    default:
      return "这次连接还没确认完成。可以继续检查已有的应用，不会重新创建。";
  }
}

/** How often, and for how long, an open approval page asks Feishu again. */
export const APPROVAL_CHECK_MILLISECONDS = 30_000;
export const APPROVAL_CHECK_LIMIT = 20;

export interface FeishuApprovalWatch {
  /** The snapshot to present: a check in flight never replaces the waiting page. */
  snapshot: DesktopSnapshot;
  /** A candidate is waiting for an administrator and this page is watching. */
  waiting: boolean;
  checking: boolean;
  /** Automatic checks stopped; the customer may check once more. */
  paused: boolean;
  checkNow(): void;
}

function awaitingApproval(snapshot: DesktopSnapshot): boolean {
  const candidate = snapshot.feishu.candidate;
  return (
    candidate?.state === "needsAction" &&
    candidate.problem === "permissions_approval_required"
  );
}

/**
 * While a visible page waits for a Feishu administrator, re-run the ordinary
 * candidate check on a bounded schedule. It stops on any result other than
 * "still waiting", when the page is hidden or left, after a failed check, and
 * after `APPROVAL_CHECK_LIMIT` attempts. Its own check's transient "checking"
 * frame does not replace the waiting page or move focus.
 */
export function useFeishuApprovalWatch(
  live: DesktopSnapshot,
  perform: (action: DesktopAction) => Promise<boolean>,
  active: boolean,
): FeishuApprovalWatch {
  const waitingLive = awaitingApproval(live);
  const held = useRef(live.feishu.candidate);
  if (waitingLive) held.current = live.feishu.candidate;
  const [inFlight, setInFlight] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [failed, setFailed] = useState(false);
  const [owner, setOwner] = useState(live.selectedBotId);
  const generation = useRef(0);
  // Settings keeps this hook mounted when switching partners. Reset before
  // rendering the new partner and ignore any reply from the previous watch.
  if (owner !== live.selectedBotId) {
    setOwner(live.selectedBotId);
    generation.current++;
    held.current = waitingLive ? live.feishu.candidate : null;
    setInFlight(false);
    setAttempts(0);
    setFailed(false);
  }
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  // The waiting page stays up from the start of a check until its answer lands.
  const holding =
    inFlight || (attempts > 0 && live.feishu.candidate?.state === "checking");
  const waiting = active && (waitingLive || (holding && held.current !== null));
  const paused = waiting && (failed || attempts >= APPROVAL_CHECK_LIMIT);
  useEffect(() => {
    const update = () => {
      const shown = document.visibilityState === "visible";
      setVisible(shown);
      // Returning to the page starts a fresh, bounded watch.
      if (shown) setAttempts(0);
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const check = useCallback(() => {
    if (!active || !waitingLive || inFlight || live.busy !== null) return;
    const started = generation.current;
    setInFlight(true);
    setAttempts((value) => value + 1);
    void perform({ type: "checkFeishuCandidate" })
      .then(
        (ok) => {
          if (generation.current === started) setFailed(!ok);
        },
        () => {
          if (generation.current === started) setFailed(true);
        },
      )
      .finally(() => {
        if (generation.current === started) setInFlight(false);
      });
  }, [perform, active, waitingLive, inFlight, live.busy]);
  useEffect(() => {
    if (!waitingLive) {
      setFailed(false);
      if (!holding) setAttempts(0);
    }
  }, [waitingLive, holding]);
  useEffect(() => {
    if (
      !active ||
      !visible ||
      !waitingLive ||
      inFlight ||
      failed ||
      attempts >= APPROVAL_CHECK_LIMIT ||
      live.busy !== null
    )
      return;
    const timer = setTimeout(check, APPROVAL_CHECK_MILLISECONDS);
    return () => clearTimeout(timer);
  }, [
    active,
    visible,
    waitingLive,
    inFlight,
    failed,
    attempts,
    live.busy,
    check,
  ]);
  return {
    snapshot:
      holding && !waitingLive && held.current
        ? {
            ...live,
            feishu: { ...live.feishu, candidate: held.current },
          }
        : live,
    waiting,
    checking: inFlight,
    paused,
    checkNow: () => {
      setFailed(false);
      setAttempts(0);
      check();
    },
  };
}

/** Same connection controls in first-run and Settings; no second setup owner. */
export function FeishuConnectionPanel({
  snapshot,
  perform,
  watch,
  heading = true,
  preview = false,
}: {
  snapshot: DesktopSnapshot;
  perform(action: DesktopAction): Promise<boolean>;
  /** The page's approval watch; present wherever this panel can be visible. */
  watch?: FeishuApprovalWatch;
  heading?: boolean;
  preview?: boolean;
}) {
  const act = (action: DesktopAction) => void perform(action);
  const view = feishuPresentation(snapshot);
  const candidate = snapshot.feishu.candidate;
  const bot = candidate?.bot ?? snapshot.feishu.active?.bot;
  const managing =
    heading && !candidate && snapshot.feishu.active?.state === "ready";
  const disabled =
    snapshot.busy !== null ||
    !snapshot.controlReady ||
    snapshot.setup === "initializing";
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(timer);
  }, [copied]);
  const approval = view.action?.value.type === "copyFeishuApprovalLink";
  const run = (action: DesktopAction) => {
    if (action.type !== "copyFeishuApprovalLink") return act(action);
    void perform(action).then((ok) => setCopied(ok));
  };
  return (
    <section
      aria-label="群聊机器人连接"
      className="feishu-connection space-y-4"
    >
      {heading && (
        <div className="feishu-connection-heading flex items-start gap-3">
          {bot && <GroupAvatar group={bot} />}
          <div className="min-w-0">
            <h3 className="text-base font-semibold [overflow-wrap:anywhere]">
              {view.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {view.detail}
            </p>
          </div>
        </div>
      )}
      {!heading && bot && (
        <div className="flex items-center gap-3 py-2">
          <GroupAvatar group={bot} />
          <div className="min-w-0">
            <p className="text-base font-semibold [overflow-wrap:anywhere]">
              {bot.name}
            </p>
            <p className="mt-1 text-xs text-muted">
              这是你在群聊里会见到的机器人
            </p>
          </div>
        </div>
      )}
      {candidate?.state === "registering" && (
        <div
          className="flex flex-wrap items-center gap-x-8 gap-y-4"
          role="status"
        >
          {preview ? (
            <div className="grid size-[176px] place-content-center border border-dashed border-hairline bg-card text-center text-sm leading-relaxed">
              扫码区域预览
              <br />
              <span className="text-xs text-muted">不生成有效二维码</span>
            </div>
          ) : snapshot.feishuVerificationQr ? (
            <img
              src={snapshot.feishuVerificationQr}
              alt="用飞书或 Lark 扫码，确认连接机器人"
              className="size-[176px] shrink-0 rounded-sm bg-white"
            />
          ) : (
            <Button
              disabled={disabled}
              onClick={() => act({ type: "connectFeishu" })}
            >
              继续这次扫码
            </Button>
          )}
          <div className="flex min-w-0 flex-col items-start gap-1">
            {snapshot.canReopenFeishuConnection && (
              <>
                <p className="mb-2 text-sm text-muted">
                  也可以在这台 Mac 上继续
                </p>
                <Button
                  variant="text"
                  className="m-0 inline-flex min-h-10 items-center gap-3 px-0 text-action"
                  disabled={disabled}
                  onClick={() => act({ type: "reopenFeishuConnection" })}
                >
                  在浏览器中打开 <Glyph name="external" size={14} />
                </Button>
              </>
            )}
            <Button
              variant="text"
              className="mt-1 px-0 text-muted"
              disabled={disabled}
              onClick={() => act({ type: "cancelFeishuConnection" })}
            >
              取消扫码
            </Button>
          </div>
        </div>
      )}
      {view.action && !managing && (
        <JourneyAction
          disabled={disabled}
          onClick={() => run(view.action!.value)}
        >
          <span aria-live="polite">
            {copied ? "已复制权限链接" : view.action.label}
          </span>
        </JourneyAction>
      )}
      {approval && watch?.waiting && (
        <p
          role="status"
          className="flex min-h-5 items-center gap-1.5 text-xs leading-5 text-muted"
        >
          {watch.checking ? (
            <>
              <Glyph name="spinner" size={13} spin />
              正在检查审批结果…
            </>
          ) : watch.paused ? (
            "已暂停自动检查。管理员批准后，可以再检查一次。"
          ) : (
            "每 30 秒自动检查一次审批结果。"
          )}
        </p>
      )}
      {(candidate?.state === "checking" ||
        snapshot.feishu.active?.state === "checking") && (
        <Glyph name="spinner" size={22} className="text-action" spin />
      )}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-5 gap-y-2 empty:hidden [&>button]:mt-0 [&>button]:px-0 [&>button]:text-muted",
          managing && "border-t border-hairline pt-4",
        )}
      >
        {managing && view.action && (
          <Button
            variant="text"
            disabled={disabled}
            onClick={() => act(view.action!.value)}
          >
            {view.action.label}
          </Button>
        )}
        {approval && (
          <Button
            variant="text"
            disabled={disabled}
            onClick={() => act({ type: "feishuSettings" })}
          >
            查看权限申请 <Glyph name="external" size={14} />
          </Button>
        )}
        {approval && watch?.paused && (
          <Button variant="text" disabled={disabled} onClick={watch.checkNow}>
            再检查一次
          </Button>
        )}
        {candidate?.state === "needsAction" &&
          !approval &&
          (needsAuthorization(candidate.problem) ||
            candidate.problem === "publication_required") && (
            <Button
              variant="text"
              disabled={disabled}
              onClick={() => act({ type: "checkFeishuCandidate" })}
            >
              已处理，检查并继续
            </Button>
          )}
        {((snapshot.feishu.active && !candidate) ||
          candidate?.state === "ready") && (
          <Button
            variant="text"
            disabled={disabled}
            onClick={() => act({ type: "feishuSettings" })}
          >
            打开机器人设置 <Glyph name="external" size={14} />
          </Button>
        )}
        {snapshot.feishu.active && !candidate && (
          <Button
            variant="text"
            disabled={disabled}
            onClick={() => act({ type: "disconnectFeishu" })}
          >
            断开连接…
          </Button>
        )}
      </div>
      {candidate && candidate.state !== "registering" && (
        // Abandoning is deliberate and rare: it sits apart, below the way forward.
        <Button
          variant="text"
          size="small"
          className="m-0 min-h-8 px-0 text-xs text-muted"
          disabled={disabled}
          onClick={() => act({ type: "discardFeishuCandidate" })}
        >
          放弃这次连接
        </Button>
      )}
      {heading && (
        <p className="text-xs leading-relaxed text-muted">{view.note}</p>
      )}
    </section>
  );
}
