import { log } from "./log.ts";

/**
 * Where one Bot's serving runtime is.
 *
 * - `standby`: not serving. Before start, paused, or waiting for its model
 *   connection or Feishu channel to change.
 * - `unconnected`: the permanent Session is verified, but the Bot has no Feishu channel.
 * - `connecting`: the Session is verified and the event stream started, but it
 *   has not reported a connection yet, or lost it and is reconnecting itself.
 * - `listening`: the event stream is connected.
 * - `failed`: the worker or the event stream ended without being asked to.
 *   Only this Bot recovers from it.
 * - `stopping`: the Bot is shutting down. Nothing leaves this state.
 */
export type BotRuntimeState = "standby" | "unconnected" | "connecting" | "listening" | "failed" | "stopping";

/** Every move the runtime can make. Anything else is a broken invariant. */
const TRANSITIONS: Readonly<Record<BotRuntimeState, readonly BotRuntimeState[]>> = {
  standby: ["unconnected", "connecting", "stopping"],
  unconnected: ["standby", "failed", "stopping"],
  connecting: ["listening", "standby", "failed", "stopping"],
  listening: ["connecting", "standby", "failed", "stopping"],
  failed: ["unconnected", "connecting", "standby", "stopping"],
  stopping: [],
};

/**
 * The one owner of a Bot's runtime state. Admission and recovery read it; the
 * published status is written from it and never read back.
 */
export class BotRuntime {
  #state: BotRuntimeState = "standby";

  constructor(private readonly botId: string) {}

  get state(): BotRuntimeState { return this.#state; }

  /** The Session is verified and the Bot is meant to be answering. */
  get serving(): boolean {
    return this.#state === "unconnected" || this.#state === "connecting" || this.#state === "listening";
  }

  get stopping(): boolean { return this.#state === "stopping"; }

  /** Moves to `next`. Staying in place is a no-op; an undeclared move throws. */
  move(next: BotRuntimeState, reason: string): void {
    if (next === this.#state) return;
    if (!TRANSITIONS[this.#state].includes(next)) {
      throw new Error(`Invalid Bot runtime transition ${this.#state} -> ${next} (${reason})`);
    }
    log.info("bot.runtime.transition", { botId: this.botId, from: this.#state, to: next, reason });
    this.#state = next;
  }
}
