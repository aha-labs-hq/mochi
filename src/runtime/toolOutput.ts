export type RuntimeToolOutputItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function textToolOutput(value: unknown): RuntimeToolOutputItem[] {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}
