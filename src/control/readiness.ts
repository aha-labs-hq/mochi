import type { FleetStatusSnapshot } from "./statusSnapshot.ts";

/**
 * Whether one Bot has reached a state the deployment can call settled.
 *
 * A Bot that is blocked or waiting for its own connection is settled: it has
 * published a definitive state that the customer can act on. Only a Bot that is
 * still starting, stopping or holding work is not, because nothing about it can
 * be reported yet.
 */
export function isSettledBot(
  bot: Pick<FleetStatusSnapshot["bots"][number], "lifecycle" | "eventStreamReady">,
): boolean {
  return (bot.lifecycle === "listening" && bot.eventStreamReady)
    || bot.lifecycle === "setup"
    || bot.lifecycle === "awaitingLogin"
    || bot.lifecycle === "awaitingConnection"
    || bot.lifecycle === "blocked"
    || bot.lifecycle === "failed";
}

/**
 * Readiness is a deployment fact, not a per-Bot one: the control plane is up once
 * the Bridge serves control and every enabled Bot has reached a settled state.
 * One blocked Bot must not keep a service install waiting for its timeout.
 */
export function isStableControlPlane(
  snapshot: Pick<FleetStatusSnapshot, "controlAvailable" | "bots">,
): boolean {
  return snapshot.controlAvailable
    && snapshot.bots.every((bot) => !bot.enabled || isSettledBot(bot));
}

/** A one-line, human-readable reason a deployment is or is not ready. */
export function describeReadiness(
  snapshot: Pick<FleetStatusSnapshot, "controlAvailable" | "bots" | "problem">,
): string {
  if (!snapshot.controlAvailable) {
    return `control plane unavailable: ${snapshot.problem?.code ?? "inspect structured logs"}`;
  }
  const enabled = snapshot.bots.filter((bot) => bot.enabled);
  if (!enabled.length) return "no Bot is enabled";
  const unsettled = enabled.filter((bot) => !isSettledBot(bot));
  if (unsettled.length) {
    return `waiting for ${unsettled.map((bot) => `${bot.label}=${bot.lifecycle}`).join(",")}`;
  }
  const running = enabled.filter((bot) => bot.lifecycle === "listening" && bot.eventStreamReady);
  if (running.length === enabled.length) return "ready";
  return `ready with attention: ${enabled
    .filter((bot) => !running.includes(bot))
    .map((bot) => `${bot.label}=${bot.problem?.code ?? bot.lifecycle}`)
    .join(",")}`;
}
