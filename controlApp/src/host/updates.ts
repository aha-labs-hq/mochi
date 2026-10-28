import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { compareProductVersions } from "../../../src/control/updateLifecycle.ts";
import {
  readUpdateFeed,
  readUpdateFeedResponse,
  type UpdateFeed,
  type UpdateRelease,
  type UpdateTrust,
  updateIsSupported,
} from "../../../src/product/updateFeed.ts";
import {
  initialUpdateView,
  type UpdatePreferences,
  type UpdateView,
} from "../shared/updates.ts";
import type { UpdateServiceState } from "./updateService.ts";

export interface UpdateDependencies {
  cache: string;
  version: string;
  macOS: string;
  trust: UpdateTrust | null;
  fetch: typeof fetch;
  service(
    command: "status" | "cancel" | "install",
    candidate?: string,
  ): Promise<UpdateServiceState>;
  close(automatic: boolean): Promise<boolean>;
  repair?(): Promise<void>;
  changed(view: UpdateView): void;
}
/** Owns discovery, transfer and user intent. It never replaces product files. */
export class DesktopUpdates {
  view = initialUpdateView();
  #release: UpdateRelease | null = null;
  #feed = "";
  #seen = "";
  #seenHash = "";
  #paused: string | null = null;
  #receipt = "";
  #writes: Promise<void> = Promise.resolve();
  #checking = false;
  #transfer: AbortController | null = null;
  #installing = false;
  #submitting = false;
  #generation = 0;
  #automatic = false;
  #closing = false;
  #closeDeclined = false;
  #polling = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly d: UpdateDependencies) {}

  async start(): Promise<void> {
    if (!this.d.trust) return;
    try {
      await mkdir(this.d.cache, { recursive: true, mode: 0o700 });
      const dir = await lstat(this.d.cache);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        dir.uid !== process.getuid!()
      )
        throw Error("update_storage");
      await chmod(this.d.cache, 0o700);
      try {
        const saved = await this.#readStored("preferences.json");
        if (
          typeof saved.check === "boolean" &&
          typeof saved.download === "boolean" &&
          typeof saved.install === "boolean"
        )
          this.view.preferences = {
            check: saved.check,
            download: saved.download,
            install: saved.install,
          };
        if (
          typeof saved.seen === "string" &&
          /^\d{4}-\d\d-\d\dT/.test(saved.seen) &&
          typeof saved.seenHash === "string" &&
          /^[a-f0-9]{64}$/.test(saved.seenHash)
        ) {
          this.#seen = saved.seen;
          this.#seenHash = saved.seenHash;
        }
        if (
          typeof saved.paused === "string" &&
          /^[a-f0-9]{64}$/.test(saved.paused)
        )
          this.#paused = saved.paused;
        if (typeof saved.receipt === "string" && saved.receipt.length <= 200)
          this.#receipt = saved.receipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw Error("update_storage");
      }
      this.#set({ phase: "idle" });
      await this.#poll();
      if (
        !this.#installing &&
        this.view.preferences.check &&
        !["completed", "restored", "failed"].includes(this.view.phase)
      )
        void this.check(false);
      this.#timer = setInterval(() => {
        if (this.#installing) void this.#poll();
        else if (
          this.view.error !== "recovery" &&
          this.view.preferences.check &&
          !this.#checking &&
          !this.#transfer &&
          Date.now() - Date.parse(this.view.checkedAt ?? "1970-01-01") >
            6 * 3600_000
        )
          void this.check(false);
      }, 1000);
      this.#timer.unref();
    } catch {
      this.#set({ phase: "failed", error: "storage" });
    }
  }
  stop(): void {
    clearInterval(this.#timer);
    this.#transfer?.abort();
  }
  async preferences(value: UpdatePreferences): Promise<void> {
    this.#set({ preferences: { ...value } });
    try {
      await this.#savePreferences();
    } catch {
      this.#set({ phase: "failed", error: "storage" });
      return;
    }
    if (!value.download) this.pause();
    if (!value.install && this.#automatic && this.#installing)
      await this.cancel();
    if (value.check && !this.#installing) void this.check(false);
  }
  async check(manual = true): Promise<void> {
    if (!this.d.trust || this.#checking || this.#transfer || this.#installing)
      return;
    // Only the helper can resolve an unfinished native transaction. A feed
    // check must not report the product current (and drop the way back) while
    // that transaction, and the paused intake it implies, is still unresolved.
    if (this.view.error === "recovery") {
      await this.#poll();
      if (this.view.error === "recovery") return;
    }
    this.#checking = true;
    const previous = this.view.phase;
    if (manual) this.#set({ phase: "checking", error: null });
    try {
      const published = await this.#refreshFeed();
      this.#set({ checkedAt: new Date().toISOString(), error: null });
      if (
        !this.#release ||
        compareProductVersions(this.#release.version, this.d.version) <= 0
      ) {
        this.#set({
          phase: this.#release || !published ? "current" : "withdrawn",
          target: null,
          notes: "",
          received: 0,
          total: 0,
        });
        return;
      }
      if (!updateIsSupported(this.#release, this.d.version, this.d.macOS)) {
        this.#set({ phase: "failed", error: "verification" });
        return;
      }
      const paused = this.#paused === this.#release.candidateSha256;
      this.#set({
        phase: paused ? "paused" : "available",
        target: this.#release.version,
        notes: this.#release.notes,
        total: this.#release.artifact.size,
      });
      if (this.view.preferences.download && !paused) void this.download();
    } catch (error) {
      if (manual) this.#set({ phase: "failed", error: this.#error(error) });
      else this.#set({ phase: previous, checkedAt: new Date().toISOString() });
    } finally {
      this.#checking = false;
    }
  }
  pause(): void {
    if (this.#transfer) {
      this.#paused = this.#release?.candidateSha256 ?? null;
      this.#transfer.abort();
      this.#set({ phase: "paused" });
      void this.#savePreferences().catch(() =>
        this.#set({ phase: "failed", error: "storage" }),
      );
    }
  }
  async download(): Promise<void> {
    if (!this.#release || !this.d.trust || this.#transfer || this.#installing)
      return;
    const release = this.#release,
      transfer = new AbortController();
    this.#transfer = transfer;
    const part = join(this.d.cache, "Mochi.part"),
      complete = join(this.d.cache, "Mochi.dmg");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      this.#paused = null;
      await this.#savePreferences();
      let same = false;
      try {
        same =
          (await this.#readStored("download.json")).candidate ===
          release.candidateSha256;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw Error("update_storage");
      }
      if (!same) {
        await rm(part, { force: true });
        await rm(complete, { force: true });
        await this.#write("download.json", {
          candidate: release.candidateSha256,
        });
      }
      if (await this.#validFile(complete, release)) {
        this.#set({
          phase: "ready",
          received: release.artifact.size,
          total: release.artifact.size,
        });
        return;
      }
      file = await open(
        part,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid!() ||
        info.size > release.artifact.size
      )
        throw Error("update_storage");
      let received = info.size;
      const space = await statfs(this.d.cache);
      if (
        space.bavail * space.bsize <
        release.artifact.size - received + 2 * release.artifact.size
      )
        throw Error("update_storage");
      this.#set({
        phase: "downloading",
        error: null,
        received,
        total: release.artifact.size,
      });
      if (received < release.artifact.size) {
        const headerTimer = setTimeout(
          () => transfer.abort(Error("update_network")),
          30_000,
        );
        let response: Response;
        try {
          response = await this.d.fetch(
            new URL(release.artifact.path, this.d.trust.origin),
            {
              redirect: "error",
              headers: received
                ? { Range: `bytes=${received}-`, "Accept-Encoding": "identity" }
                : { "Accept-Encoding": "identity" },
              signal: AbortSignal.any([
                transfer.signal,
                AbortSignal.timeout(30 * 60_000),
              ]),
            },
          );
        } finally {
          clearTimeout(headerTimer);
        }
        if (response.status === 200 && received > 0) {
          await file.truncate(0);
          received = 0;
        }
        if (
          !(response.status === 200 && received === 0) &&
          !(
            response.status === 206 &&
            response.headers.get("content-range") ===
              `bytes ${received}-${release.artifact.size - 1}/${release.artifact.size}`
          )
        )
          throw Error("update_network");
        if (
          !response.body ||
          (response.headers.get("content-encoding") &&
            response.headers.get("content-encoding") !== "identity")
        )
          throw Error("update_network");
        const reader = response.body.getReader();
        try {
          while (true) {
            const timer = setTimeout(
              () => transfer.abort(Error("update_network")),
              30_000,
            );
            let item: Awaited<ReturnType<typeof reader.read>>;
            try {
              item = await reader.read();
            } finally {
              clearTimeout(timer);
            }
            if (item.done) break;
            if (received + item.value.byteLength > release.artifact.size)
              throw Error("update_verification");
            let offset = 0;
            while (offset < item.value.length) {
              const written = await file.write(
                item.value,
                offset,
                item.value.length - offset,
                received,
              );
              if (written.bytesWritten <= 0) throw Error("update_storage");
              offset += written.bytesWritten;
              received += written.bytesWritten;
            }
            this.#set({ received });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      await file.sync();
      await file.close();
      file = undefined;
      if (received !== release.artifact.size) throw Error("update_network");
      if (!(await this.#validFile(part, release))) {
        await rm(part, { force: true });
        throw Error("update_verification");
      }
      await rename(part, complete);
      this.#set({ phase: "ready", received: release.artifact.size });
    } catch (error) {
      this.#set({
        phase:
          transfer.signal.aborted && this.view.phase === "paused"
            ? "paused"
            : "failed",
        error:
          transfer.signal.aborted && this.view.phase === "paused"
            ? null
            : this.#error(error),
      });
    } finally {
      await file?.close();
      this.#transfer = null;
      if (this.view.phase === "ready" && this.view.preferences.install)
        void this.install(true);
    }
  }
  async retry(): Promise<void> {
    if (this.view.error === "recovery") {
      try {
        const state = await this.d.service("status");
        if (!state.candidateSha256 && this.d.repair) {
          await this.d.repair();
          await this.#poll();
          return;
        }
        if (
          !state.candidateSha256 ||
          !/^[a-f0-9]{64}$/.test(state.candidateSha256)
        )
          throw Error("update_permission");
        this.#installing = true;
        this.#submitting = true;
        this.#generation++;
        this.#automatic = false;
        this.#closeDeclined = false;
        const result = await this.d.service("install", state.candidateSha256);
        if (result.phase === "failed") throw Error("update_permission");
        this.#set({ phase: "preparing", error: null });
      } catch {
        this.#installing = false;
        this.#set({ phase: "failed", error: "recovery" });
      } finally {
        this.#submitting = false;
      }
      if (this.#installing) void this.#poll();
    } else await this.check();
  }
  async install(automatic = false): Promise<void> {
    if (this.view.phase !== "ready" || !this.#release || this.#installing)
      return;
    const candidate = this.#release.candidateSha256;
    this.#installing = true;
    this.#submitting = true;
    this.#generation++;
    try {
      await this.#refreshFeed();
      if (!this.#release || this.#release.candidateSha256 !== candidate) {
        this.#installing = false;
        this.#set({
          phase: this.#release ? "available" : "withdrawn",
          target: this.#release?.version ?? null,
          notes: this.#release?.notes ?? "",
          total: this.#release?.artifact.size ?? 0,
          received: 0,
          error: null,
        });
        return;
      }
      await this.#write("feed.json", this.#feed, true);
      this.#automatic = automatic;
      this.#closeDeclined = false;
      this.#installing = true;
      const state = await this.d.service("install", candidate);
      if (state.phase === "failed")
        throw Error(`update_${this.#serviceError(state.error)}`);
      this.#set({ phase: "preparing", error: null });
    } catch (error) {
      this.#installing = false;
      this.#set({ phase: "failed", error: this.#error(error) });
    } finally {
      this.#submitting = false;
    }
    if (this.#installing) void this.#poll();
  }
  async cancel(): Promise<void> {
    if (
      !this.#installing ||
      !["preparing", "waiting", "closing"].includes(this.view.phase)
    )
      return;
    try {
      const response = await this.d.service("cancel");
      if (response.phase !== "cancelling") throw Error("update_permission");
    } catch {
      this.#set({ error: "permission" });
    }
  }
  async #poll(): Promise<void> {
    if (this.#polling || this.#submitting) return;
    this.#polling = true;
    const generation = this.#generation;
    try {
      const state = await this.d.service("status");
      if (state.mode === "uninstall") return;
      // An older response cannot cancel observation of a newly accepted install.
      if (generation !== this.#generation || this.#submitting) return;
      // A same-version repair reports its outcome through the preparation that
      // started it. Only its unfinished transaction, which keeps intake paused
      // until the helper resolves it, belongs to this view.
      if (state.mode === "repair" && state.error !== "recoveryRequired") {
        if (this.view.error === "recovery")
          this.#set({ phase: "idle", error: null });
        return;
      }
      const terminal = ["idle", "completed", "restored", "failed"].includes(
        state.phase,
      );
      this.#installing = !terminal;
      if (state.phase === "idle" || state.phase === "cancelling") return;
      if (state.phase === "completed" && state.targetVersion !== this.d.version)
        return;
      if (["completed", "restored"].includes(state.phase)) {
        const receipt = `${state.phase}:${state.targetVersion}:${state.candidateSha256 ?? "repair"}`;
        if (receipt === this.#receipt) return;
        this.#receipt = receipt;
        await this.#savePreferences();
      }
      if (state.phase === "failed" && state.error === "cancelled") {
        this.#set({ phase: this.#release ? "ready" : "idle", error: null });
        return;
      }
      this.#set({
        phase: state.phase,
        target: state.targetVersion ?? this.view.target,
        checkedAt: new Date().toISOString(),
        error:
          state.phase === "failed" ? this.#serviceError(state.error) : null,
      });
      if (state.phase === "closing" && !this.#closing && !this.#closeDeclined) {
        this.#closing = true;
        try {
          if (!(await this.d.close(this.#automatic))) {
            this.#closeDeclined = true;
            await this.cancel();
          }
        } finally {
          this.#closing = false;
        }
      }
    } catch {
      if (
        generation === this.#generation &&
        !this.#submitting &&
        this.#installing
      )
        this.#set({ phase: "failed", error: "permission" });
    } finally {
      this.#polling = false;
    }
  }
  /** False when no release is published on the fixed official feed. */
  async #refreshFeed(): Promise<boolean> {
    const trust = this.d.trust!;
    const response = await this.d.fetch(new URL(trust.feedPath, trust.origin), {
      redirect: "error",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    // The official feed answers 404 until a release is published there. That
    // is an answer, not a transport failure: nothing is offered.
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      this.#release = null;
      return false;
    }
    const text = await readUpdateFeedResponse(response);
    let feed: UpdateFeed;
    try {
      feed = readUpdateFeed(text, trust);
    } catch {
      throw Error("update_verification");
    }
    const hash = createHash("sha256")
      .update(JSON.parse(text).payload)
      .digest("hex");
    if (
      this.#seen &&
      (feed.issuedAt < this.#seen ||
        (feed.issuedAt === this.#seen && hash !== this.#seenHash))
    )
      throw Error("update_verification");
    this.#seen = feed.issuedAt;
    this.#seenHash = hash;
    await this.#savePreferences();
    this.#feed = text;
    this.#release = feed.withdrawn ? null : feed.release;
    return true;
  }
  async #validFile(path: string, release: UpdateRelease): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw Error("update_storage");
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid!() ||
        info.size !== release.artifact.size
      )
        return false;
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false }))
        hash.update(chunk);
      return hash.digest("hex") === release.artifact.sha256;
    } finally {
      await file.close();
    }
  }
  async #readStored(name: string): Promise<Record<string, unknown>> {
    const file = await open(
      join(this.d.cache, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid!() ||
        info.size > 65_536
      )
        throw Error("update_storage");
      const data = JSON.parse(await file.readFile("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("update_storage");
      return data;
    } finally {
      await file.close();
    }
  }
  async #savePreferences(): Promise<void> {
    await this.#write("preferences.json", {
      ...this.view.preferences,
      seen: this.#seen,
      seenHash: this.#seenHash,
      paused: this.#paused,
      receipt: this.#receipt,
    });
  }
  #write(name: string, value: unknown, raw = false): Promise<void> {
    const writing = this.#writes.then(() => this.#writeFile(name, value, raw));
    this.#writes = writing.catch(() => {});
    return writing;
  }
  async #writeFile(name: string, value: unknown, raw: boolean): Promise<void> {
    const path = join(this.d.cache, name),
      temp = `${path}.new`;
    const file = await open(
      temp,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(raw ? (value as string) : JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }
  #serviceError(error: string | undefined): NonNullable<UpdateView["error"]> {
    return error === "recoveryRequired"
      ? "recovery"
      : error === "untrusted" || error === "invalid"
        ? "verification"
        : "installation";
  }
  #error(error: unknown): NonNullable<UpdateView["error"]> {
    const message = error instanceof Error ? error.message : "";
    return message.includes("storage")
      ? "storage"
      : message.includes("verification")
        ? "verification"
        : message.includes("recovery")
          ? "recovery"
          : message.includes("installation")
            ? "installation"
            : message.includes("permission") ||
                message.includes("update_service")
              ? "permission"
              : "network";
  }
  #set(change: Partial<UpdateView>): void {
    this.view = { ...this.view, ...change };
    this.d.changed(this.view);
  }
}
