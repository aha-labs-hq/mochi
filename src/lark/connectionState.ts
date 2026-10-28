import { isGroupAvatarUrl, isGroupName } from "./group.ts";
import { isLarkBrand, type LarkBrand } from "./platform.ts";

export const FEISHU_CONNECTION_FAILURES = [
  "connection_storage_unavailable", "registration_in_progress", "registration_cancelled",
  "registration_expired", "registration_failed", "registration_output_invalid", "registration_stage_invalid",
  "candidate_required", "candidate_unverified", "bot_already_connected", "credential_unavailable", "identity_changed",
  "provider_unavailable", "provider_response_invalid", "permissions_required", "permissions_approval_required", "group_messages_required", "publication_required",
] as const;
export type FeishuConnectionFailure = typeof FEISHU_CONNECTION_FAILURES[number];

export class FeishuConnectionError extends Error {
  constructor(readonly code: FeishuConnectionFailure) { super(code); this.name = "FeishuConnectionError"; }
}

/** Renderer-safe identity. No credential, config path, verification URL or internal app ID. */
export interface FeishuBot {
  name: string;
  avatarUrl: string | null;
}

export interface FeishuConnectionSnapshot {
  active: { state: "checking" | "ready" | "unavailable"; bot: FeishuBot | null; brand: LarkBrand } | null;
  candidate: { state: "registering" | "checking" | "needsAction" | "ready"; bot: FeishuBot | null;
    problem: FeishuConnectionFailure | null; brand: LarkBrand | null } | null;
}

export type FeishuConnectionProgress = {
  [K in keyof FeishuConnectionSnapshot]: Omit<NonNullable<FeishuConnectionSnapshot[K]>, "brand"> | null;
};

export const emptyFeishuSnapshot = (): FeishuConnectionSnapshot => ({ active: null, candidate: null });

export function isFeishuBot(value: unknown): value is FeishuBot {
  return record(value) && keys(value, "avatarUrl,name") && typeof value.name === "string"
    && isGroupName(value.name) && isGroupAvatarUrl(value.avatarUrl);
}

export function isFeishuConnectionSnapshot(value: unknown): value is FeishuConnectionSnapshot {
  if (!record(value) || !keys(value, "active,candidate")) return false;
  const active = value.active;
  const candidate = value.candidate;
  return (active === null || (record(active) && keys(active, "bot,brand,state") && isLarkBrand(active.brand)
    && ["checking", "ready", "unavailable"].includes(String(active.state))
    && (active.bot === null || isFeishuBot(active.bot)) && (active.state !== "ready" || active.bot !== null)))
    && (candidate === null || (record(candidate) && keys(candidate, "bot,brand,problem,state") && (candidate.brand === null || isLarkBrand(candidate.brand))
      && ["registering", "checking", "needsAction", "ready"].includes(String(candidate.state))
      && (candidate.bot === null || isFeishuBot(candidate.bot))
      && (candidate.problem === null || FEISHU_CONNECTION_FAILURES.includes(candidate.problem as FeishuConnectionFailure))
      && (candidate.state !== "ready" || (candidate.bot !== null && candidate.problem === null && isLarkBrand(candidate.brand)))));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string): boolean { return Object.keys(value).sort().join(",") === expected; }
