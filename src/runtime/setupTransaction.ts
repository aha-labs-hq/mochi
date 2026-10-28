import type { RuntimeSessionState } from "../runtime/protocol.ts";
import type { StateStore } from "../state.ts";

export interface RuntimeSetupSessionClient {
  bootstrapSession(): Promise<RuntimeSessionState>;
  resumeSession(): Promise<RuntimeSessionState>;
  close(): Promise<void>;
}

/**
 * Performs the irreversible first-run boundary: bootstrap, independent resume,
 * then atomic activation. The prepared candidate remains durable on failure.
 */
export async function activateVerifiedRuntimeSetup(input: {
  state: StateStore;
  bootstrapClient: RuntimeSetupSessionClient;
  createVerifier(): RuntimeSetupSessionClient;
}): Promise<RuntimeSessionState> {
  if (input.state.runtimeSession()) throw new Error("Mochi 已经完成设置。");
  if (input.state.runtimeSessionMigration()) throw new Error("对话迁移尚未完成。");
  const candidateSessionId = input.state.runtimeSetupSessionId();
  if (!candidateSessionId) throw new Error("Mochi 尚未准备固定的首次对话身份。");

  const session = await verifyPreparedSession({
    candidateSessionId,
    preparationClient: input.bootstrapClient,
    prepare: () => input.bootstrapClient.bootstrapSession(),
    createVerifier: input.createVerifier,
    identityError: () => new Error("Mochi 首次对话与准备的身份不一致。"),
    verificationError: () => new Error("Mochi 无法独立复验新对话。"),
  });
  input.state.activateRuntimeSetupSession(session.sessionId, session.capabilityAbi);
  return session;
}

async function verifyPreparedSession(input: {
  candidateSessionId: string;
  preparationClient: RuntimeSetupSessionClient;
  prepare(): Promise<RuntimeSessionState>;
  createVerifier(): RuntimeSetupSessionClient;
  identityError(): Error;
  verificationError(): Error;
}): Promise<RuntimeSessionState> {
  const session = await input.prepare();
  await input.preparationClient.close();
  if (session.sessionId !== input.candidateSessionId) throw input.identityError();
  const verifier = input.createVerifier();
  try {
    const resumed = await verifier.resumeSession();
    if (
      resumed.sessionId !== session.sessionId
      || resumed.capabilityAbi !== session.capabilityAbi
    ) throw input.verificationError();
  } finally {
    await verifier.close();
  }
  return session;
}
