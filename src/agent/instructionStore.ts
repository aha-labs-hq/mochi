import { createHash } from "node:crypto";
import { PrivateRecord } from "../privateRecord.ts";
import { log } from "../log.ts";
import { parseInstructionDocument, type InstructionDocument } from "./instructionDocument.ts";

export class InstructionsError extends Error {
  constructor(readonly code: "instructions_unavailable" | "instructions_conflict") {
    super(code);
    this.name = "InstructionsError";
  }
}

/** Bridge owns one deployment-selected Markdown file. No caller can choose a path. */
export class InstructionStore {
  readonly #record: PrivateRecord<string>;

  constructor(path: string) {
    this.#record = new PrivateRecord(path, (value) => {
      if (typeof value !== "string") throw new Error("Invalid instructions");
      return document(value).content;
    }, () => new InstructionsError("instructions_unavailable"), 131_072, {
      decode: (text) => text,
      encode: (text) => text,
    });
  }

  read(): InstructionDocument {
    const content = this.#record.read();
    if (content === undefined) throw new InstructionsError("instructions_unavailable");
    return document(content);
  }

  save(input: InstructionDocument): InstructionDocument {
    const proposed = parseInstructionDocument(input);
    const current = this.read();
    // A response may have been lost after a successful save. This is not a second write.
    if (current.content === proposed.content) return current;
    if (current.revision !== proposed.revision) throw new InstructionsError("instructions_conflict");
    this.#record.write(proposed.content);
    const saved = this.read();
    if (saved.content !== proposed.content) throw new InstructionsError("instructions_conflict");
    log.info("bot.instructions.saved", { previousRevision: current.revision, revision: saved.revision });
    return saved;
  }
}

function document(content: string): InstructionDocument {
  return parseInstructionDocument({ content, revision: createHash("sha256").update(content).digest("hex") });
}
