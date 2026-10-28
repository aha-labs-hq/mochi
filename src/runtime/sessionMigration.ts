import type { StateStore } from "../state.ts";

/** Offline maintainer transition; the caller must hold the same process lock.
 * Preparation alone is never authority to change the live Session binding.
 */
export async function activatePreparedRuntimeMigration(options: {
  state: StateStore;
  sourceSessionId: string;
  capabilityAbi: string;
  createVerifier(sessionId: string): {
    resumeSession(): Promise<{ sessionId: string; capabilityAbi: string }>;
    close(): Promise<void>;
  };
}): Promise<string> {
  const { state, sourceSessionId, capabilityAbi } = options;
  const binding = state.runtimeSession();
  const candidate = state.runtimeSessionMigration();
  if (!binding || binding.sessionId !== sourceSessionId || !candidate
    || candidate.sourceSessionId !== sourceSessionId || candidate.capabilityAbi !== capabilityAbi) {
    throw new Error("No matching reviewed Runtime Session migration is prepared");
  }
  const verifier = options.createVerifier(candidate.targetSessionId);
  try {
    const resumed = await verifier.resumeSession();
    if (resumed.sessionId !== candidate.targetSessionId || resumed.capabilityAbi !== capabilityAbi) {
      throw new Error("Migration verifier resumed an unexpected Session or capability ABI");
    }
  } finally { await verifier.close(); }
  // StateStore revalidates source/candidate atomically before preserving lineage.
  state.activateRuntimeSession(candidate.targetSessionId, capabilityAbi);
  return candidate.targetSessionId;
}
