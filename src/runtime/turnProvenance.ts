export class SteeredTurnProvenance {
  #currentSourceMessageId: string;
  #initialMessageStarted = false;
  #userStartedSinceAssistant = false;
  #assistantSourceMessageId: string | undefined;
  readonly #queuedSourceMessageIds: string[] = [];
  readonly #knownSourceMessageIds = new Set<string>();

  constructor(initialSourceMessageId: string) {
    this.#currentSourceMessageId = initialSourceMessageId;
    this.#knownSourceMessageIds.add(initialSourceMessageId);
  }

  get currentSourceMessageId(): string {
    return this.#currentSourceMessageId;
  }

  get toolSourceMessageId(): string {
    if (!this.#assistantSourceMessageId) {
      throw new Error("Pi requested a tool before starting a provenance-bound assistant message");
    }
    return this.#assistantSourceMessageId;
  }

  enqueue(sourceMessageId: string): void {
    if (this.#knownSourceMessageIds.has(sourceMessageId)) {
      throw new Error(`Duplicate Feishu source message provenance: ${sourceMessageId}`);
    }
    this.#knownSourceMessageIds.add(sourceMessageId);
    this.#queuedSourceMessageIds.push(sourceMessageId);
  }

  rollback(sourceMessageId: string): void {
    if (this.#queuedSourceMessageIds.at(-1) !== sourceMessageId) {
      throw new Error(`Cannot roll back active Feishu source message provenance: ${sourceMessageId}`);
    }
    this.#queuedSourceMessageIds.pop();
    this.#knownSourceMessageIds.delete(sourceMessageId);
  }

  userMessageStarted(): void {
    if (!this.#initialMessageStarted) {
      this.#initialMessageStarted = true;
      this.#userStartedSinceAssistant = true;
      return;
    }
    const sourceMessageId = this.#queuedSourceMessageIds.shift();
    if (!sourceMessageId) {
      throw new Error("Pi started a user message without queued Feishu provenance");
    }
    this.#currentSourceMessageId = sourceMessageId;
    this.#userStartedSinceAssistant = true;
  }

  assistantMessageStarted(): void {
    if (!this.#initialMessageStarted) {
      throw new Error("Pi started an assistant message before its Feishu user provenance");
    }
    if (
      this.#assistantSourceMessageId
      && this.#queuedSourceMessageIds.length > 0
      && !this.#userStartedSinceAssistant
    ) {
      throw new Error("Pi started another assistant message without advancing queued Feishu provenance");
    }
    this.#assistantSourceMessageId = this.#currentSourceMessageId;
    this.#userStartedSinceAssistant = false;
  }

  assertSettled(): void {
    if (!this.#initialMessageStarted) {
      throw new Error("Pi completed without starting the initial Feishu user message");
    }
    if (!this.#assistantSourceMessageId) {
      throw new Error("Pi completed without a provenance-bound assistant message");
    }
    if (this.#queuedSourceMessageIds.length > 0) {
      throw new Error("Pi completed before all steered Feishu messages were processed");
    }
  }
}
