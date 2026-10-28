import {
  ByokInputError,
  type ByokInputField,
  isByokFailureCode,
} from "../../../src/runtime/byok.ts";
import { DesktopFailure } from "../shared/problem.ts";

/** Native-only feedback. Neither the draft nor its key crosses a renderer RPC. */
export interface ByokPromptProblem {
  message: string;
  field?: ByokInputField;
}

/** Existing credential-free values used to make an edit form recognizable. */
export interface ByokPromptInitial {
  baseUrl: string;
  model: string;
  label: string;
}

export function byokPromptProblem(error: unknown): ByokPromptProblem {
  if (error instanceof ByokInputError) {
    const message = {
      apiKey: "请粘贴完整的 API Key，不要包含空格或换行。",
      baseUrl:
        "请填写以 https:// 开头的 API 地址，不要包含账号、查询参数或 #。",
      model: "请填写服务商提供的有效模型名称。",
      label: "请填写一个简短的连接名称。",
      connectionId: "请重新选择一个已存在的模型 API 连接。",
    }[error.field];
    return { message, field: error.field };
  }
  if (
    error instanceof DesktopFailure &&
    isByokFailureCode(error.problem.code)
  ) {
    return {
      message: `${error.problem.title}。${error.problem.message}`,
      ...(error.problem.code === "byok_model_unsupported"
        ? { field: "model" as const }
        : error.problem.code === "byok_auth_rejected"
          ? { field: "apiKey" as const }
          : error.problem.code === "byok_endpoint_unavailable"
            ? { field: "baseUrl" as const }
            : {}),
    };
  }
  // Broken transport/unknown commit outcome must go to the normal diagnostic
  // path, not invite another paid request from a stale form.
  throw error;
}
