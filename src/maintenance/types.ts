/**
 * Argument parsing shared by the offline maintenance commands.
 *
 * Every maintenance command operates on exactly one Bot, so they all accept the
 * same `--bot <id>` selector and nothing else. Parsing lives here so no command
 * grows a second convention for naming the Bot it is about to change.
 */
export function botArgument(argv: readonly string[], command: string, extra: readonly string[] = []): string | undefined {
  const rest = argv.filter((argument) => !extra.includes(argument));
  if (rest.length === 0) return undefined;
  if (rest.length !== 2 || rest[0] !== "--bot") {
    const options = extra.length ? ` [${extra.join("] [")}]` : "";
    throw new Error(`Usage: ${command} [--bot <id>]${options}`);
  }
  return rest[1];
}
