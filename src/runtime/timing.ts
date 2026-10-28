/** Deadlines shared by the worker transport and its callers. */
export const RUNTIME_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const WORKER_TERMINATION_GRACE_MILLISECONDS = 5_000;
// Large permanent Sessions can take several minutes to summarize.
export const CONTEXT_ORGANIZATION_TIMEOUT_MILLISECONDS = 600_000;
export const WORKER_RECOVERY_TIMEOUT_MILLISECONDS = WORKER_TERMINATION_GRACE_MILLISECONDS
  + 2 * RUNTIME_REQUEST_TIMEOUT_MILLISECONDS; // initialize, then resume
