import {
  SCHEDULE_PROBLEMS,
  type ScheduleProblem,
  type ScheduleRecord,
  type ScheduleRunStatus,
  type ScheduleStore,
} from "./store.ts";

export interface ScheduleResult {
  status: Exclude<ScheduleRunStatus, "running" | "interrupted">;
  problem: ScheduleProblem | null;
}
export class ScheduleExecutionError extends Error {
  constructor(
    readonly problem: "execution_failed" | "delivery_failed",
    cause: unknown,
  ) {
    super(problem, { cause });
  }
}

export interface ScheduleOccurrence {
  schedule: ScheduleRecord;
  dueAt: number;
  coalesced: boolean;
  startedAt: number;
}

export interface ScheduleDispatcherOptions {
  store: ScheduleStore;
  /** Synchronous host admission; false must leave every occurrence unclaimed. */
  canStart(): boolean;
  /** Re-prove channel/resource authority, run the normal Session, then deliver. */
  execute(occurrence: ScheduleOccurrence): Promise<ScheduleResult>;
  executionFailed(occurrence: ScheduleOccurrence, error: unknown): void;
  /** Infrastructure failure stops the clock and must be visible to the owner. */
  failed(error: unknown): void;
  now?: () => number;
}

/** One Bot, one clock, one in-flight occurrence; storage owns all time decisions. */
export class ScheduleDispatcher {
  readonly #options: ScheduleDispatcherOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active: Promise<ScheduleOccurrence | null> | undefined;
  #closed = false;

  constructor(options: ScheduleDispatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): number {
    if (this.#closed) throw new Error("安排调度器已关闭。");
    if (this.#timer) return 0;
    const interrupted = this.#options.store.recoverInterrupted(this.#now());
    // A bounded wall-clock observation also handles sleep/wake and clock changes.
    // This interval is an observation ceiling, never a recurrence authority.
    this.#timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.stopClock();
        this.#options.failed(error);
      });
    }, 15_000);
    this.#timer.unref?.();
    return interrupted;
  }

  tick(): Promise<ScheduleOccurrence | null> {
    if (this.#active) return this.#active;
    if (this.#closed) return Promise.resolve(null);
    // Reserve the in-flight slot before invoking host code, including a
    // synchronous execute callback that could re-enter tick().
    const run = Promise.resolve().then(() =>
      this.#closed || !this.#options.canStart() ? null : this.#run(),
    );
    this.#active = run;
    void run.then(
      () => {
        this.#active = undefined;
      },
      () => {
        this.#active = undefined;
      },
    );
    return run;
  }

  async #run(): Promise<ScheduleOccurrence | null> {
    const now = this.#now();
    const due = this.#options.store.due(now);
    if (!due) return null;
    // No await between the host's admission decision and durable claim.
    const claimed = this.#options.store.claim(due.id, due.revision, now);
    if (!claimed) return null;
    const occurrence = { ...claimed, startedAt: now };
    let result: ScheduleResult;
    try {
      result = await this.#options.execute(occurrence);
      if (
        !["delivered", "failed", "blocked"].includes(result.status) ||
        (result.problem !== null &&
          !SCHEDULE_PROBLEMS.includes(result.problem)) ||
        (result.status === "delivered"
          ? result.problem !== null
          : result.problem === null)
      )
        throw new Error("安排执行返回了未知状态。");
    } catch (error) {
      // At-most-once: an ambiguous model or delivery failure is recorded. It
      // does not reinsert the occurrence or prevent the next normal recurrence.
      this.#options.store.finish(
        due.id,
        occurrence.dueAt,
        "failed",
        this.#now(),
        error instanceof ScheduleExecutionError
          ? error.problem
          : "execution_failed",
      );
      this.#options.executionFailed(occurrence, error);
      return occurrence;
    }
    this.#options.store.finish(
      due.id,
      occurrence.dueAt,
      result.status,
      this.#now(),
      result.problem,
    );
    return occurrence;
  }

  stopClock(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.stopClock();
    // The host owns cancellation of its accepted Session work. Closing only
    // prevents new claims and waits for the active run to finish its record.
    await this.#active?.catch(() => undefined);
  }
}
