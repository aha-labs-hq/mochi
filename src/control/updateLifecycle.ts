import { randomUUID } from "node:crypto";

/** Stable across product/control versions. This handshake is not a model tool. */
export const UPDATE_LIFECYCLE_VERSION = 1;
export const UPDATE_LEASE_MILLISECONDS = 120_000;
const digest = /^[a-f0-9]{64}$/;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type UpdateLifecycleRequest =
  | { lifecycle: "update"; version: 1; command: "health" }
  | {
      lifecycle: "update";
      version: 1;
      command: "acquire";
      targetVersion: string;
      sha256: string;
    }
  | {
      lifecycle: "update";
      version: 1;
      command: "release" | "stop";
      lease: string;
    };
export type UpdateLifecycleResponse =
  | {
      lifecycle: "update";
      version: 1;
      ok: true;
      pid: number;
      productVersion: string;
      lease?: string;
      expiresAt?: number;
      initialized?: boolean;
      failures?: string[];
    }
  | {
      lifecycle: "update";
      version: 1;
      ok: false;
      reason: "busy" | "invalid" | "expired" | "unavailable";
    };

export function compareProductVersions(a: string, b: string): number {
  if (!version.test(a) || !version.test(b))
    throw new Error("Invalid product version");
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}

export function parseUpdateLifecycleRequest(
  value: unknown,
): UpdateLifecycleRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid update request");
  const x = value as Record<string, unknown>;
  const keys =
    x.command === "health"
      ? ["lifecycle", "version", "command"]
      : x.command === "acquire"
        ? ["lifecycle", "version", "command", "targetVersion", "sha256"]
        : ["lifecycle", "version", "command", "lease"];
  if (
    Object.keys(x).length !== keys.length ||
    keys.some((k) => !(k in x)) ||
    x.lifecycle !== "update" ||
    x.version !== 1
  )
    throw new Error("Invalid update request");
  if (x.command === "acquire") {
    if (
      typeof x.targetVersion !== "string" ||
      x.targetVersion.length > 64 ||
      !version.test(x.targetVersion) ||
      typeof x.sha256 !== "string" ||
      !digest.test(x.sha256)
    )
      throw new Error("Invalid update target");
  } else if (
    x.command !== "health" &&
    ((x.command !== "release" && x.command !== "stop") ||
      typeof x.lease !== "string" ||
      !/^[a-f0-9-]{36}$/.test(x.lease))
  )
    throw new Error("Invalid update lease");
  return x as UpdateLifecycleRequest;
}

/**
 * One synchronous admission decision for the entire deployment. No awaited
 * gap may separate the idle proof from closing admission. Busy installations
 * keep working; only a granted, short-lived lease closes new work. A crashed
 * client cannot leave a running Bridge paused indefinitely.
 */
export class UpdateLifecycle {
  #operations = 0;
  #lease: { id: string; expiresAt: number } | undefined;
  #stopping = false;
  constructor(
    readonly productVersion: string,
    private readonly idle: () => boolean,
    private readonly now = Date.now,
    private readonly held: () => boolean = () => false,
  ) {}

  get acceptingWork(): boolean {
    this.#expire();
    return !this.#stopping && !this.#lease && !this.held();
  }

  enterOperation(): (() => void) | null {
    if (!this.acceptingWork) return null;
    this.#operations++;
    let finished = false;
    return () => {
      if (!finished) {
        finished = true;
        this.#operations--;
      }
    };
  }

  handle(request: UpdateLifecycleRequest): UpdateLifecycleResponse {
    this.#expire();
    const failure = (
      reason: "busy" | "invalid" | "expired",
    ): UpdateLifecycleResponse => ({
      lifecycle: "update",
      version: 1,
      ok: false,
      reason,
    });
    const success = (): Extract<UpdateLifecycleResponse, { ok: true }> => ({
      lifecycle: "update",
      version: 1,
      ok: true,
      pid: process.pid,
      productVersion: this.productVersion,
    });
    if (request.command === "health") return success();
    if (request.command === "acquire") {
      // The same signed version may repair its components through the same
      // admission boundary. Only the release helper accepts newer versions.
      if (
        compareProductVersions(request.targetVersion, this.productVersion) < 0
      )
        return failure("invalid");
      if (!this.acceptingWork || this.#operations !== 0 || !this.idle())
        return failure("busy");
      this.#lease = {
        id: randomUUID(),
        expiresAt: this.now() + UPDATE_LEASE_MILLISECONDS,
      };
      return {
        ...success(),
        lease: this.#lease.id,
        expiresAt: this.#lease.expiresAt,
      };
    }
    if (this.#stopping || !this.#lease || this.#lease.id !== request.lease)
      return failure("expired");
    if (request.command === "stop") this.#stopping = true;
    this.#lease = undefined;
    return success();
  }

  #expire(): void {
    if (this.#lease && this.now() >= this.#lease.expiresAt)
      this.#lease = undefined;
  }
}
