import {
  type ProductProblemCode,
  type ProductProblemSnapshot,
  productProblem,
  type RecoveryAction,
} from "../../../src/control/productProblem.ts";
import type { DesktopSnapshot } from "./model.ts";
import { SUPPORT_EMAIL } from "./support.ts";

type DesktopRecoveryAction = RecoveryAction | "openLoginItems";

const localProblems = {
  background_permission_required: [
    "Mochi 的后台运行已关闭",
    "请在系统设置的“登录项”中允许 Mochi 在后台运行。已有设置和记忆会保留。",
    "openLoginItems",
  ],
  background_permission_unavailable: [
    "Mochi 无法确认后台权限",
    "系统没有返回可确认的后台运行权限，请保存诊断以便检查。",
    "exportDiagnostics",
  ],
  bot_view_changed: [
    "已切换伙伴",
    "这次操作没有执行。请在当前伙伴的页面重新操作。",
    "retry",
  ],
  preview_active: [
    "当前为体验预览",
    "请先结束预览，再操作真实连接或后台。",
    "wait",
  ],
  action_in_progress: ["操作正在进行", "请等待当前操作结束。", "wait"],
  installation_required: [
    "Mochi 需要完成首次准备",
    "需要一次 macOS 管理员授权来准备安全的后台组件。",
    "prepareProduct",
  ],
  application_location_invalid: [
    "请先安装 Mochi",
    "请把 Mochi 拖到“应用程序”文件夹，再从那里打开。",
    "openApplicationsFolder",
  ],
  product_preparation_failed: [
    "Mochi 没有准备完成",
    "可以重新准备。已有设置和工作记录不会被清除。",
    "prepareProduct",
  ],
  product_uninstall_failed: [
    "Mochi 尚未完成卸载",
    "应用会保留。请在运行诊断中修复后台组件，再重新选择卸载。已删除的数据无法恢复。",
    "prepareProduct",
  ],
  component_contract_unavailable: [
    "Mochi 组件需要更新",
    "App 的兼容性信息缺失或无效。",
    "contactReleaseIssuer",
  ],
  service_configuration_invalid: [
    "Mochi 后台需要修复",
    "后台组件无法正常使用，请让 Mochi 重新准备。",
    "prepareProduct",
  ],
  service_identity_mismatch: [
    "Mochi 与后台不匹配",
    "发现了另一套后台。为保护已有工作记录，Mochi 没有切换或替换它。",
    "exportDiagnostics",
  ],
  service_operation_failed: [
    "Mochi 没有完成这次操作",
    "请稍后再试一次。",
    "retry",
  ],
  service_shutdown_failed: [
    "Mochi 还没有完全停止",
    "后台进程尚未全部结束或无法确认。窗口会保留，请稍后再次退出。",
    "retry",
  ],
  service_readiness_timeout: [
    "Mochi 没有正常启动",
    `这次连接没有完成。请导出诊断，发送到 ${SUPPORT_EMAIL}。`,
    "exportDiagnostics",
  ],
  status_unavailable: [
    "Mochi 暂时没有回应",
    "后台状态暂时无法确认。",
    "restartService",
  ],
  status_expired: [
    "Mochi 暂时没有回应",
    "后台状态已经过期。",
    "restartService",
  ],
  control_unavailable: [
    "Mochi 本机控制不可用",
    "暂时无法连接后台。",
    "restartService",
  ],
  control_response_invalid: [
    "Mochi 返回了无法识别的结果",
    "App 不会接受不符合当前合同的结果。",
    "exportDiagnostics",
  ],
  /** Only the ChatGPT login: its pending attempt is what the recovery reopens. */
  login_browser_unavailable: [
    "浏览器没有打开",
    "ChatGPT 登录仍在等待，可以再次打开浏览器继续。",
    "reopenBrowser",
  ],
  browser_unavailable: [
    "浏览器没有打开",
    "请再试一次。正在进行的授权会保留。",
    "retry",
  ],
  model_policy_out_of_sync: [
    "模型设置没有更新",
    "后台没有发布与新设置一致的状态。",
    "retry",
  ],
  diagnostics_export_failed: [
    "诊断文件没有导出",
    "请重新选择保存位置。",
    "retry",
  ],
  motion_resources_invalid: [
    "角色动效不可用",
    "App 中的角色资源缺失或与运行协议不一致。",
    "contactReleaseIssuer",
  ],
} as const satisfies Record<
  string,
  readonly [string, string, DesktopRecoveryAction]
>;

const bridgeCopy = {
  schedules_unavailable: [
    "暂时无法读取安排",
    "请确认后台已连接；需要时重启后台后再查看。",
  ],
  schedules_update_failed: [
    "安排没有更新",
    "列表已按当前安排显示，请确认后再操作。",
  ],
  schedules_conflict: [
    "安排已经变化",
    "列表已按最新内容显示，请确认后再决定是否继续。",
  ],
  schedule_time_passed: [
    "需要重新约定时间",
    "这个一次性安排已过期，请在群里告诉伙伴新的时间。",
  ],
  skills_unavailable: ["暂时无法读取技能", "请确认后台已连接后再试。"],
  instructions_unavailable: [
    "暂时无法读写嘱咐",
    "修改还留在这里。请确认后台已连接后再试。",
  ],
  instructions_conflict: [
    "嘱咐已在别处修改",
    "你的草稿已保留。请查看最新内容，合并后再保存。",
  ],
  connection_change_busy: [
    "这位伙伴正在处理消息",
    "当前工作完成后，就可以更换连接或调整项目。",
  ],
  feishu_connection_failed: [
    "群聊连接还没完成",
    "请在群聊连接中查看当前这一步，再继续。",
  ],
  github_connection_failed: [
    "GitHub 连接没有完成",
    "请在 GitHub 设置中检查连接后重试。",
  ],
  github_issuer_not_configured: [
    "这份 Mochi 尚未准备好 GitHub 登录",
    "这是发行配置问题，无需你安装工具或填写密钥。",
  ],
  github_selection_failed: [
    "项目选择没有更新",
    "可选项目会自动更新，请确认后重新选择。",
  ],
  connector_selection_failed: [
    "连接器资源没有更新",
    "请确认群聊已连接，并检查添加的文档是否已把机器人加为协作者。",
  ],
  connector_reference_invalid: [
    "资料链接无法识别",
    "请粘贴云文档或知识库链接。原文不会被改动。",
  ],
  connector_resource_unreadable: [
    "这份资料暂时无法读取",
    "请确认群聊机器人能打开这份资料，或换一个已分享的链接。",
  ],
  connector_resource_unavailable: [
    "固定资料暂时无法确认",
    "Mochi 会自动重试，现有机器人授权仍然保留。",
  ],
  connector_provider_unavailable: [
    "文档服务暂时没有回应",
    "请稍后重试。无需重新授权机器人。",
  ],
  connector_provider_response_invalid: [
    "平台返回的资料信息不完整",
    "请稍后重试，或确认链接仍然有效。无需重新授权机器人。",
  ],
  feishu_mail_unavailable: [
    "邮箱服务暂时没有回应",
    "请稍后重试。已选择的邮箱和现有授权不受影响。",
  ],
  feishu_mail_app_scope_required: [
    "需要先开通邮件读取权限",
    "Mochi 的机器人应用还没有开通读取邮箱的权限，需要应用管理员在对应的开放平台开通。开通后回到这里再授权一次。",
  ],
  feishu_mail_selection_failed: [
    "共享邮箱没有更新",
    "邮箱列表会自动更新，请确认后重新选择。邮箱里的邮件不会被改动。",
  ],
  group_inventory_unavailable: [
    "暂时无法确认所在群",
    "Mochi 会自动重试，确认前不会接收新的群消息。",
  ],
  group_participation_update_failed: [
    "群聊设置没有更新",
    "这个群保持原来的回应设置，可以再切换一次。",
  ],
  bridge_startup_failed: ["Mochi 没有正常启动", "请导出不含消息和凭据的诊断。"],
  account_status_unavailable: ["模型连接暂时不可用", "无法确认当前连接状态。"],
  runtime_session_unavailable: [
    "长期对话没有恢复",
    "模型已连接，但长期工作上下文没有安全恢复。",
  ],
  account_change_recovery_failed: [
    "长期对话没有恢复",
    "账号操作后的工作上下文没有安全恢复。",
  ],
  event_stream_unavailable: [
    "暂时收不到群消息",
    "群聊消息连接断开了，群里的新消息暂时进不来。连接恢复后会继续接收。",
  ],
  login_listener_busy: [
    "另一个浏览器登录正在进行",
    "请先完成或取消正在进行的另一个 ChatGPT 登录，再继续。",
  ],
  login_failed: [
    "ChatGPT 登录没有完成",
    "请重新发起登录，并在浏览器中完成授权。",
  ],
  byok_connection_failed: [
    "连接没有完成",
    "服务没有返回可用的回复。请确认服务支持 Responses API，并检查 API 地址和模型名称。",
  ],
  byok_model_unsupported: [
    "这个模型暂不支持",
    "请填写 Mochi 支持的 OpenAI Responses 模型名称，例如 gpt-6-sol。",
  ],
  byok_auth_rejected: [
    "服务拒绝了这次授权",
    "请检查 API Key 是否有效，以及是否有权使用这个模型。",
  ],
  byok_endpoint_unavailable: [
    "找不到服务或模型",
    "请核对服务商提供的 API 地址和模型名称。",
  ],
  byok_rate_limited: [
    "服务暂时限制了请求",
    "请在服务商处检查可用额度，或稍后再试。",
  ],
  byok_service_unavailable: [
    "模型服务暂时不可用",
    "服务端遇到了问题，请稍后再试。无需重新填写密钥。",
  ],
  byok_network_unavailable: [
    "暂时连不上模型服务",
    "请检查网络和 API 地址，然后重试。无需重新填写密钥。",
  ],
  byok_timeout: ["连接验证超时", "这次验证已停止。请检查网络或稍后重试。"],
  model_policy_unavailable: [
    "需要重新选择模型",
    "在这位伙伴的模型设置中，选择当前连接可用的模型。工作记录会保留。",
  ],
  setup_failed: ["没能开始值班", "请重新开始值班。已完成的设置会保留。"],
  account_required: [
    "需要连接模型",
    "连接 ChatGPT 订阅或添加模型 API 后才能继续。",
  ],
  login_in_progress: ["ChatGPT 登录正在进行", "继续当前浏览器授权。"],
  account_already_signed_in: ["模型已经连接", "请先断开当前连接再切换。"],
  login_must_complete: [
    "请先处理当前登录",
    "完成或取消正在进行的浏览器授权后才能继续。",
  ],
  setup_required: ["请先完成 Mochi 准备", "首次准备完成后，这项功能才会开放。"],
  context_organization_failed: [
    "记忆没有整理完",
    "已有的工作记录保持原样。等这位伙伴空闲时，再整理一次。",
  ],
  login_cancel_failed: [
    "登录没有取消",
    "浏览器里的授权可能还在进行。完成它，或稍等片刻再取消一次。",
  ],
  logout_failed: [
    "ChatGPT 没有退出",
    "账号仍保持连接。伙伴们都空闲时才能退出，请等手头的消息处理完再试。",
  ],
  byok_disconnect_failed: [
    "模型 API 连接没有断开",
    "这个连接仍然保留。伙伴们都空闲时才能断开，请等手头的消息处理完再试。",
  ],
  account_switch_failed: [
    "ChatGPT 账号没有切换",
    "原有长期工作上下文仍被保留。",
  ],
  model_catalog_unavailable: [
    "暂时没有可用模型",
    "无法读取当前连接可用的模型。",
  ],
  model_policy_update_failed: [
    "模型设置没有更新",
    "仍在使用原来的模型和思考深度。等这位伙伴空闲时，再保存一次。",
  ],
  bot_creation_failed: [
    "没有新增伙伴",
    "已有的伙伴不受影响，可以稍后再新增一次。",
  ],
  bot_character_failed: ["形象没有更新", "仍是原来的形象，可以再选一次。"],
  bot_rename_failed: [
    "名字没有更新",
    "仍是原来的名字。新名字还留在输入框里，可以再保存一次。",
  ],
  bot_activation_failed: [
    "值班状态没有更新",
    "开关保持原来的状态，可以再切换一次。",
  ],
  bot_unknown: [
    "找不到这位伙伴",
    "它可能已在别处被移除，这次操作没有执行。请在当前的伙伴上重新操作。",
  ],
  bot_not_running: ["这位伙伴没有在运行", "先开始值班，再修改这项设置。"],
  fleet_storage_unavailable: [
    "伙伴名单无法读取",
    "重新准备 Mochi 后就能再读取，已有的伙伴和记录会保留。",
  ],
  component_contract_mismatch: [
    "Mochi 组件需要更新",
    "App 与后台组件无法安全协作。",
  ],
} as const satisfies Record<ProductProblemCode, readonly [string, string]>;

export type ProblemCode = ProductProblemCode | keyof typeof localProblems;
export interface DesktopProblem {
  code: ProblemCode;
  title: string;
  message: string;
  recoveryAction: DesktopRecoveryAction;
}

/** A verified running service supersedes an earlier readiness timeout. Other
 * failed actions (saving, exporting, authorization) need their own resolution;
 * merely receiving a fresh frame does not prove that they succeeded. */
export function reconcileActionProblem(
  value: DesktopProblem | null,
  snapshot: DesktopSnapshot,
): DesktopProblem | null {
  // A second click while the host's serialized operation is settling is a
  // coordination outcome, not a product failure. The page owns the visible
  // in-progress state and should never turn this race into an error banner.
  if (value?.code === "action_in_progress") return null;
  if (
    value?.code === "background_permission_required" &&
    snapshot.installed &&
    snapshot.problem?.code !== "background_permission_required"
  )
    return null;
  if (
    value?.code === "service_readiness_timeout" &&
    snapshot.problem === null &&
    snapshot.installed &&
    snapshot.loaded &&
    snapshot.controlReady &&
    snapshot.eventStreamReady &&
    ["listening", "working", "contextFull", "organizingContext"].includes(
      snapshot.phase,
    )
  )
    return null;
  return value;
}

export function problem(code: ProblemCode): DesktopProblem {
  if (Object.hasOwn(localProblems, code)) {
    const [title, message, recoveryAction] =
      localProblems[code as keyof typeof localProblems];
    return { code, title, message, recoveryAction };
  }
  return bridgeProblem(productProblem(code as ProductProblemCode));
}
export function bridgeProblem(value: ProductProblemSnapshot): DesktopProblem {
  const [title, message] = bridgeCopy[value.code];
  return {
    code: value.code,
    title,
    message,
    recoveryAction: value.recoveryAction,
  };
}
export class DesktopFailure extends Error {
  /** A stable code for what failed underneath (an errno, a native status), for the private log only. */
  readonly reason: string | undefined;
  constructor(
    readonly problem: DesktopProblem,
    reason?: string,
  ) {
    super(problem.code);
    this.name = "DesktopFailure";
    this.reason = reason;
  }
}
export function fail(code: ProblemCode, reason?: string): never {
  throw new DesktopFailure(problem(code), reason);
}
export function projectFailure(
  error: unknown,
  code: ProblemCode,
): DesktopProblem {
  return error instanceof DesktopFailure ? error.problem : problem(code);
}
