import { errorFields, log } from "../log.ts";
import type { LarkMessenger, ReactionEmoji } from "./messenger.ts";

export type ReplyFeedback = "replied" | "waiting" | "blocked" | "failed";

/** Transport progress is temporary. The reply, not a reaction, describes the delivered result. */
export class MessageFeedback {
  readonly #messenger: Pick<LarkMessenger, "createReaction" | "deleteReaction">;
  readonly #source: { botId: string; messageId: string };
  #pending: Promise<void>;
  #reactionId: string | undefined;
  #started = false;
  #finished = false;

  constructor(
    messenger: Pick<LarkMessenger, "createReaction" | "deleteReaction">,
    source: { botId: string; messageId: string },
  ) {
    this.#messenger = messenger;
    this.#source = source;
    this.#pending = this.#transition("OnIt");
  }

  started(): void {
    if (this.#finished || this.#started) return;
    this.#started = true;
    this.#pending = this.#pending.then(() => this.#transition("Typing"));
  }

  finish(feedback: ReplyFeedback): Promise<void> {
    if (this.#finished) return this.#pending;
    this.#finished = true;
    const emoji = feedback === "waiting" ? "THINKING"
      : feedback === "blocked" ? "FROWN"
      : feedback === "failed" ? "ERROR" : undefined;
    this.#pending = this.#pending.then(() => this.#transition(emoji));
    return this.#pending;
  }

  async #transition(emojiType: ReactionEmoji | undefined): Promise<void> {
    let replacement: string | undefined;
    if (emojiType) {
      try {
        replacement = await this.#messenger.createReaction(this.#source.messageId, emojiType);
      } catch (error) {
        log.warn("bot.reaction.create_failed", { ...this.#source, emojiType, ...errorFields(error) });
      }
    }
    const previous = this.#reactionId;
    this.#reactionId = replacement;
    if (!previous) return;
    try {
      await this.#messenger.deleteReaction(this.#source.messageId, previous);
    } catch (error) {
      log.warn("bot.reaction.delete_failed", {
        ...this.#source, reactionId: previous,
        ...(replacement ? { replacementReactionId: replacement } : {}), ...errorFields(error),
      });
    }
  }
}
