import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const MAXIMUM_INSTRUCTION_CHARACTERS = 32_768;
export const instructionDocumentSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: MAXIMUM_INSTRUCTION_CHARACTERS, pattern: "\\S" }),
  revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
export type InstructionDocument = Static<typeof instructionDocumentSchema>;
const validator = Compile(instructionDocumentSchema);
const requestSchema = Type.Union([
  Type.Object({ type: Type.Literal("read") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("save"), document: instructionDocumentSchema }, { additionalProperties: false }),
]);
export type InstructionsRequest = Static<typeof requestSchema>;
const requestValidator = Compile(requestSchema);

export function parseInstructionsRequest(value: unknown): InstructionsRequest {
  if (!requestValidator.Check(value)) throw new Error("Invalid instructions request");
  if (value.type === "save") parseInstructionDocument(value.document);
  return value;
}

export function parseInstructionDocument(value: unknown): InstructionDocument {
  if (!validator.Check(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.content)) {
    throw new Error("Invalid instructions document");
  }
  return value;
}
