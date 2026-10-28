import type { Logger } from "../log.ts";
import type { StateStore } from "../state.ts";
import type { FeishuRuntimeBinding } from "./connection.ts";
import { LarkEventConsumer } from "./eventConsumer.ts";
import type { FeishuGroup } from "./group.ts";
import { FeishuGroups } from "./groups.ts";
import { FeishuMessageEvidenceReader } from "./messageEvidence.ts";
import { FeishuMessageHydrator } from "./messageHydrator.ts";
import { LarkMessenger } from "./messenger.ts";
import { RecentFeishuContext } from "./recentContext.ts";

/** A turn captures this immutable connection scope. Handoff can never redirect
 * its downloads, group decisions, context, reactions or replies to another Bot.
 */
export class FeishuWorkplace {
  readonly consumer: LarkEventConsumer;
  readonly groups: FeishuGroups;
  readonly messenger: LarkMessenger;
  readonly messages: FeishuMessageHydrator;
  readonly evidence: FeishuMessageEvidenceReader;
  readonly recentContext = new RecentFeishuContext();
  /** `logger` carries the Bot's id, so every lark.* record names the Bot it belongs to. */
  constructor(readonly binding: FeishuRuntimeBinding, state: StateStore,
    stagingRoot: string,
    publish: (groups: readonly FeishuGroup[] | null) => void,
    logger: Logger) {
    this.consumer = new LarkEventConsumer(binding, logger);
    this.groups = new FeishuGroups(binding, state, publish, logger);
    this.messenger = new LarkMessenger(binding);
    this.messages = new FeishuMessageHydrator(binding, stagingRoot, undefined, undefined, undefined, logger);
    this.evidence = new FeishuMessageEvidenceReader(binding, undefined, logger);
  }
  stop(): void { this.groups.stop(); this.consumer.stop(); }
}
