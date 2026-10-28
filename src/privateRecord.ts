import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** One private, validated, crash-durable record. No symlinks or shared inode custody. */
export class PrivateRecord<T> {
  constructor(readonly path: string, private readonly parse: (value: unknown) => T,
    private readonly failure: () => Error, private readonly maximumBytes = 256_000,
    private readonly codec: { decode(text: string): unknown; encode(value: T): string } = {
      decode: JSON.parse, encode: JSON.stringify,
    }) {}

  read(): T | undefined {
    this.directory();
    let fd: number;
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; throw this.failure(); }
    try {
      const stat = fstatSync(fd);
      this.#validate(stat);
      if (stat.size > this.maximumBytes) throw this.failure();
      return this.parse(this.codec.decode(readFileSync(fd, "utf8")));
    } catch { throw this.failure(); }
    finally { closeSync(fd); }
  }

  write(value: T): void {
    const encoded = this.codec.encode(this.parse(value));
    if (Buffer.byteLength(encoded) > this.maximumBytes) throw this.failure();
    this.directory();
    const temporary = join(dirname(this.path), `.${basename(this.path)}-${randomBytes(8).toString("hex")}`);
    let fd: number | undefined;
    let created = false;
    try {
      this.#entryExists();
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      writeFileSync(fd, encoded);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      created = false;
      this.#syncDirectory();
    } catch { throw this.failure(); }
    finally { if (fd !== undefined) closeSync(fd); if (created) unlinkSync(temporary); }
  }

  clear(): void {
    this.directory();
    if (!this.#entryExists()) return;
    try { unlinkSync(this.path); this.#syncDirectory(); }
    catch { throw this.failure(); }
  }

  directory(): void {
    const directory = dirname(this.path);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== resolve(directory)) throw this.failure();
    } catch { throw this.failure(); }
  }

  #validate(stat: Stats): void {
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw this.failure();
  }
  #entryExists(): boolean {
    try { this.#validate(lstatSync(this.path)); return true; }
    catch (error) { if (missing(error)) return false; throw this.failure(); }
  }
  #syncDirectory(): void {
    const fd = openSync(dirname(this.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
