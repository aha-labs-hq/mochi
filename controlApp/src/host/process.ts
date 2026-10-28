export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  command: string[],
  options?: { input?: string; timeout?: number },
) => Promise<CommandResult>;

/** Bounded, argv-only native commands. Output is private to the host. */
export const run: CommandRunner = async (command, options = {}) => {
  const child = Bun.spawn(command, {
    cwd: "/var/empty",
    env: {
      HOME: process.env.HOME!,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
    },
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeout ?? 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      boundedText(child.stdout),
      boundedText(child.stderr),
    ]);
    if (timedOut) throw new Error("native_command_timeout");
    return { code, stdout, stderr };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

async function boundedText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error("native_command_output_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
