import { describe, expect, test } from "bun:test";
import { SteeredTurnProvenance } from "../src/runtime/turnProvenance.ts";

describe("steered turn provenance", () => {
  test("changes source only when Pi starts the queued user message", () => {
    const provenance = new SteeredTurnProvenance("om_initial");
    provenance.enqueue("om_steered_one");
    provenance.enqueue("om_steered_two");

    expect(provenance.currentSourceMessageId).toBe("om_initial");
    provenance.userMessageStarted();
    expect(provenance.currentSourceMessageId).toBe("om_initial");
    provenance.assistantMessageStarted();
    expect(provenance.toolSourceMessageId).toBe("om_initial");
    provenance.userMessageStarted();
    expect(provenance.currentSourceMessageId).toBe("om_steered_one");
    provenance.assistantMessageStarted();
    expect(provenance.toolSourceMessageId).toBe("om_steered_one");
    provenance.userMessageStarted();
    expect(provenance.currentSourceMessageId).toBe("om_steered_two");
    provenance.assistantMessageStarted();
    expect(provenance.toolSourceMessageId).toBe("om_steered_two");
    expect(() => provenance.assertSettled()).not.toThrow();
  });

  test("fails closed on unbound, duplicate, dropped, or invalid rollback state", () => {
    const unbound = new SteeredTurnProvenance("om_initial");
    expect(() => unbound.toolSourceMessageId).toThrow("before starting a provenance-bound assistant message");
    expect(() => unbound.assistantMessageStarted()).toThrow("before its Feishu user provenance");
    unbound.userMessageStarted();
    expect(() => unbound.userMessageStarted()).toThrow("without queued Feishu provenance");

    const duplicate = new SteeredTurnProvenance("om_initial");
    expect(() => duplicate.enqueue("om_initial")).toThrow("Duplicate Feishu source message provenance");

    const dropped = new SteeredTurnProvenance("om_initial");
    dropped.userMessageStarted();
    dropped.assistantMessageStarted();
    dropped.enqueue("om_steered");
    expect(() => dropped.assertSettled()).toThrow("before all steered Feishu messages were processed");
    expect(() => dropped.assistantMessageStarted()).toThrow("without advancing queued Feishu provenance");
    expect(() => dropped.rollback("om_other")).toThrow("Cannot roll back active Feishu source message provenance");
    dropped.rollback("om_steered");
    expect(() => dropped.assertSettled()).not.toThrow();
  });
});
