/**
 * The Bridge values the renderer may run: pure validators and constants of
 * Bridge-owned contracts, re-exported from their single owners. Interface code
 * imports Bridge runtime values only through this module (types may come
 * straight from the Bridge), so this list is the renderer's whole executable
 * dependency on the Bridge. A test keeps everything reachable from here free of
 * Node and Bun built-ins.
 */
export type {
  InstructionDocument,
  InstructionsRequest,
} from "../../../src/agent/instructionDocument.ts";
export {
  MAXIMUM_INSTRUCTION_CHARACTERS,
  parseInstructionDocument,
} from "../../../src/agent/instructionDocument.ts";
export type { SkillId } from "../../../src/agent/skillCatalog.ts";
export {
  BUILTIN_SKILLS,
  parseSkillCatalog,
} from "../../../src/agent/skillCatalog.ts";
export { PRODUCT_PROBLEM_CODES } from "../../../src/control/productProblem.ts";
export { isGitHubId } from "../../../src/github/repository.ts";
export type { FeishuConnectionFailure } from "../../../src/lark/connectionState.ts";
export { FEISHU_CONNECTION_FAILURES } from "../../../src/lark/connectionState.ts";
export { LARK_PLATFORMS } from "../../../src/lark/platform.ts";
export {
  isByokAccountSummary,
  isByokFailureCode,
  parseModelReference,
} from "../../../src/runtime/byok.ts";
export { isReasoningEffort } from "../../../src/runtime/policy.ts";
