import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
type BashResult = { exitCode: number | null; output: string };

/** Pi owns tool schemas, editing, images and truncation. This process has no account or Session. */
export function executionToolDefinitions(cwd: string, bashResult?: BashResult) {
  return [
    // Original image input matches material_read; no optional on-disk Photon WASM in our binary.
    createReadTool(cwd, { autoResizeImages: false }),
    createBashTool(cwd, {
      exposeSessionEnvironment: false,
      operations: {
        exec: async (_command, _directory, { onData, signal }) => {
          signal?.throwIfAborted();
          if (!bashResult) throw new Error("Shell execution requires the supervised sandbox");
          onData(Buffer.from(bashResult.output, "base64"));
          return { exitCode: bashResult.exitCode };
        },
      },
    }),
    createEditTool(cwd),
    createWriteTool(cwd),
  ];
}

export async function runExecutionTool(): Promise<void> {
  process.umask(0o077);
  const input = JSON.parse(await Bun.stdin.text()) as { name: string; args: unknown; bashResult?: BashResult };
  const tool = executionToolDefinitions(process.cwd(), input.bashResult).find(({ name }) => name === input.name);
  if (!tool) throw new Error("Unknown Pi execution tool");
  try {
    // Pi's structuredContent serves codemode only; it may duplicate a whole image.
    const { content, details, isError } = await tool.execute(crypto.randomUUID(), input.args as never);
    process.stdout.write(JSON.stringify({ ok: true, result: { content, details, isError } }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

if (import.meta.main) await runExecutionTool();
