import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductLayout } from "./layout.ts";

export interface DevelopmentServiceLifecycle {
  stop(): Promise<void>;
  start(): Promise<void>;
  verify(): Promise<void>;
  restore(): Promise<void>;
}

/** Publishes code only. Configuration, state, OAuth and the Pi worker are never replaced. */
export class DevelopmentDeployment {
  readonly directory: string;
  readonly stagedRuntime: string;
  private readonly previousRuntime: string;
  private readonly previousPlist: string;
  private readonly journalPath: string;

  constructor(private readonly layout: ProductLayout, private readonly service: DevelopmentServiceLifecycle) {
    if (layout.mode !== "development") throw new Error("Development deploy cannot alter an installed deployment");
    mkdirSync(layout.mutableRoot, { recursive: true, mode: 0o700 });
    const root = lstatSync(layout.mutableRoot);
    if (realpathSync(layout.mutableRoot) !== layout.mutableRoot || !root.isDirectory()
      || root.uid !== process.getuid!() || (root.mode & 0o077) !== 0) {
      throw new Error("Development deployment root must be a private, canonical directory");
    }
    this.directory = join(layout.mutableRoot, ".deployment");
    this.stagedRuntime = join(this.directory, "next");
    this.previousRuntime = join(this.directory, "previous");
    this.previousPlist = join(this.directory, "previous.plist");
    this.journalPath = join(this.directory, "journal.json");
  }

  begin(): void {
    if (existsSync(this.directory)) throw new Error("An interrupted deployment remains; run service:deploy --rollback first");
    mkdirSync(this.directory, { mode: 0o700 });
    mkdirSync(this.stagedRuntime, { mode: 0o700 });
    const journal = {
      version: 1,
      phase: "preparing",
      hadRuntime: existsSync(this.layout.immutableRoot),
      hadPlist: existsSync(this.layout.launchAgentPath),
    };
    if (journal.hadRuntime) this.requireExact(this.layout.immutableRoot, "directory");
    if (journal.hadPlist) {
      this.requireExact(this.layout.launchAgentPath, "file");
      copyFileSync(this.layout.launchAgentPath, this.previousPlist);
    }
    this.writeJournal(journal);
  }

  async publish(): Promise<void> {
    const journal = this.journal();
    if (journal.phase !== "preparing") throw new Error("Deployment is not prepared");
    this.requireExact(this.stagedRuntime, "directory");
    // Persist the recovery decision before the first change to the live service.
    this.writeJournal({ ...journal, phase: "publishing" });
    await this.service.stop();
    if (journal.hadRuntime) renameSync(this.layout.immutableRoot, this.previousRuntime);
    renameSync(this.stagedRuntime, this.layout.immutableRoot);
    await this.service.start();
    this.writeJournal({ ...journal, phase: "accepted" });
    this.removeTransaction();
  }

  /** Commit a timed-out publication only after the live service proves readiness. */
  async accept(): Promise<void> {
    const journal = this.journal();
    if (journal.phase !== "publishing") throw new Error("Deployment is not awaiting acceptance");
    this.requireExact(this.layout.immutableRoot, "directory");
    this.requireExact(this.previousRuntime, "directory");
    await this.service.verify();
    this.writeJournal({ ...journal, phase: "accepted" });
    this.removeTransaction();
  }

  /** Explicit recovery of code/plist only; never restore a stale database after a new process ran. */
  async rollback(): Promise<void> {
    this.requireExact(this.directory, "directory");
    if (!existsSync(this.journalPath)) {
      // begin() has not committed its first journal; no live mutation can have occurred.
      if (readdirSync(this.directory).some((name) => !["next", "previous.plist", "journal.json.tmp"].includes(name))) {
        throw new Error("Unrecognized incomplete deployment; recovery stopped");
      }
      this.removeTransaction();
      return;
    }
    const journal = this.journal();
    if (journal.phase === "accepted" || journal.phase === "preparing") {
      this.removeTransaction();
      return;
    }
    await this.service.stop();
    if (existsSync(this.previousRuntime)) {
      this.requireExact(this.previousRuntime, "directory");
      if (existsSync(this.layout.immutableRoot)) {
        this.requireExact(this.layout.immutableRoot, "directory");
        rmSync(this.layout.immutableRoot, { recursive: true });
      }
      renameSync(this.previousRuntime, this.layout.immutableRoot);
    } else if (!journal.hadRuntime && existsSync(this.layout.immutableRoot)) {
      this.requireExact(this.layout.immutableRoot, "directory");
      rmSync(this.layout.immutableRoot, { recursive: true });
    } else if (journal.hadRuntime && !existsSync(this.layout.immutableRoot)) {
      throw new Error("Previous development runtime is missing; recovery stopped");
    }
    if (journal.hadPlist) {
      this.requireExact(this.previousPlist, "file");
      const temporary = `${this.layout.launchAgentPath}.restore`;
      copyFileSync(this.previousPlist, temporary);
      renameSync(temporary, this.layout.launchAgentPath);
      await this.service.restore();
    } else if (existsSync(this.layout.launchAgentPath)) {
      this.requireExact(this.layout.launchAgentPath, "file");
      rmSync(this.layout.launchAgentPath);
    }
    this.removeTransaction();
  }

  private journal(): { version: 1; phase: "preparing" | "publishing" | "accepted"; hadRuntime: boolean; hadPlist: boolean } {
    this.requireExact(this.journalPath, "file");
    const value = JSON.parse(readFileSync(this.journalPath, "utf8"));
    if (!value || value.version !== 1 || !["preparing", "publishing", "accepted"].includes(value.phase)
      || typeof value.hadRuntime !== "boolean" || typeof value.hadPlist !== "boolean"
      || Object.keys(value).sort().join() !== "hadPlist,hadRuntime,phase,version") throw new Error("Invalid development deployment journal");
    return value;
  }

  private writeJournal(value: unknown): void {
    const temporary = `${this.journalPath}.tmp`;
    const descriptor = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, this.journalPath);
    const directory = openSync(this.directory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  private requireExact(path: string, kind: "file" | "directory"): void {
    const entry = lstatSync(path);
    if (realpathSync(path) !== path || entry.isSymbolicLink() || entry.uid !== process.getuid!()
      || !(kind === "file" ? entry.isFile() : entry.isDirectory())) throw new Error("Unsafe development deployment artifact");
  }

  private removeTransaction(): void {
    this.requireExact(this.directory, "directory");
    rmSync(this.directory, { recursive: true });
  }
}
