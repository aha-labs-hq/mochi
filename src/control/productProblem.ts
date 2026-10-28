export const RECOVERY_ACTIONS = [
  "retry",
  "reopenBrowser",
  "cancel",
  "wait",
  "prepareProduct",
  "openApplicationsFolder",
  "restartService",
  /** Reconnects one Bot's worker and Feishu events; other Bots keep working. */
  "restartBot",
  "exportDiagnostics",
  "contactReleaseIssuer",
] as const;

export const PRODUCT_PROBLEM_VERSION = 2;

export type RecoveryAction = typeof RECOVERY_ACTIONS[number];
export type ProductRecoverability =
  | "retryable"
  | "repairRequired"
  | "issuerRequired"
  | "diagnosticsRequired";

const PRODUCT_PROBLEM_DEFINITIONS = {
  schedules_unavailable: { recoverability: "retryable", recoveryAction: "restartService" },
  schedules_update_failed: { recoverability: "retryable", recoveryAction: "retry" },
  schedules_conflict: { recoverability: "retryable", recoveryAction: "retry" },
  schedule_time_passed: { recoverability: "retryable", recoveryAction: "retry" },
  instructions_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  skills_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  instructions_conflict: { recoverability: "retryable", recoveryAction: "retry" },
  feishu_connection_failed: { recoverability: "retryable", recoveryAction: "retry" },
  github_connection_failed: { recoverability: "retryable", recoveryAction: "retry" },
  github_issuer_not_configured: { recoverability: "issuerRequired", recoveryAction: "contactReleaseIssuer" },
  github_selection_failed: { recoverability: "retryable", recoveryAction: "retry" },
  connector_selection_failed: { recoverability: "retryable", recoveryAction: "retry" },
  connector_reference_invalid: { recoverability: "retryable", recoveryAction: "retry" },
  connector_resource_unreadable: { recoverability: "retryable", recoveryAction: "retry" },
  connector_resource_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  connector_provider_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  connector_provider_response_invalid: { recoverability: "retryable", recoveryAction: "retry" },
  feishu_mail_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  feishu_mail_app_scope_required: { recoverability: "retryable", recoveryAction: "retry" },
  feishu_mail_selection_failed: { recoverability: "retryable", recoveryAction: "retry" },
  connection_change_busy: { recoverability: "retryable", recoveryAction: "wait" },
  group_inventory_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  group_participation_update_failed: { recoverability: "retryable", recoveryAction: "retry" },
  bridge_startup_failed: {
    recoverability: "diagnosticsRequired",
    recoveryAction: "exportDiagnostics",
  },
  account_status_unavailable: {
    recoverability: "retryable",
    recoveryAction: "restartService",
  },
  runtime_session_unavailable: {
    recoverability: "retryable",
    recoveryAction: "restartBot",
  },
  account_change_recovery_failed: {
    recoverability: "retryable",
    recoveryAction: "restartService",
  },
  event_stream_unavailable: {
    recoverability: "retryable",
    recoveryAction: "restartBot",
  },
  login_listener_busy: { recoverability: "retryable", recoveryAction: "retry" },
  login_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  byok_connection_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  byok_model_unsupported: { recoverability: "retryable", recoveryAction: "retry" },
  byok_auth_rejected: { recoverability: "retryable", recoveryAction: "retry" },
  byok_endpoint_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  byok_rate_limited: { recoverability: "retryable", recoveryAction: "retry" },
  byok_service_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  byok_network_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  byok_timeout: { recoverability: "retryable", recoveryAction: "retry" },
  model_policy_unavailable: { recoverability: "retryable", recoveryAction: "retry" },
  setup_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  account_required: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  login_in_progress: {
    recoverability: "retryable",
    recoveryAction: "reopenBrowser",
  },
  account_already_signed_in: {
    recoverability: "retryable",
    recoveryAction: "wait",
  },
  login_must_complete: {
    recoverability: "retryable",
    recoveryAction: "cancel",
  },
  setup_required: {
    recoverability: "retryable",
    recoveryAction: "wait",
  },
  context_organization_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  login_cancel_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  logout_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  byok_disconnect_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  account_switch_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  model_catalog_unavailable: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  model_policy_update_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  bot_creation_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  bot_character_failed: { recoverability: "retryable", recoveryAction: "retry" },
  bot_rename_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  bot_activation_failed: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  bot_unknown: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  bot_not_running: {
    recoverability: "retryable",
    recoveryAction: "retry",
  },
  fleet_storage_unavailable: {
    recoverability: "repairRequired",
    recoveryAction: "prepareProduct",
  },
  component_contract_mismatch: {
    recoverability: "repairRequired",
    recoveryAction: "prepareProduct",
  },
} as const satisfies Record<string, {
  recoverability: ProductRecoverability;
  recoveryAction: RecoveryAction;
}>;

export type ProductProblemCode = keyof typeof PRODUCT_PROBLEM_DEFINITIONS;
export const PRODUCT_PROBLEM_CODES = Object.freeze(
  Object.keys(PRODUCT_PROBLEM_DEFINITIONS) as ProductProblemCode[],
);

export interface ProductProblemSnapshot {
  version: typeof PRODUCT_PROBLEM_VERSION;
  code: ProductProblemCode;
  recoverability: ProductRecoverability;
  recoveryAction: RecoveryAction;
}

export function productProblem(code: ProductProblemCode): ProductProblemSnapshot {
  return Object.freeze({ version: PRODUCT_PROBLEM_VERSION, code, ...PRODUCT_PROBLEM_DEFINITIONS[code] });
}

export function parseProductProblem(value: unknown): ProductProblemSnapshot | undefined {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join(",") !== "code,recoverability,recoveryAction,version"
    || value.version !== PRODUCT_PROBLEM_VERSION
  ) {
    return undefined;
  }
  if (typeof value.code !== "string" || !(value.code in PRODUCT_PROBLEM_DEFINITIONS)) {
    return undefined;
  }
  const expected = productProblem(value.code as ProductProblemCode);
  return value.recoverability === expected.recoverability
      && value.recoveryAction === expected.recoveryAction
    ? expected
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
