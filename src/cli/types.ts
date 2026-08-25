export interface CliCommandContext {
  /** Working directory the command was invoked from. */
  cwd: string;
}

/**
 * A CLI subcommand. Each command lives in its own module under
 * `src/cli/commands/` and returns a process exit code (0 = success).
 */
export interface CliCommand {
  name: string;
  description: string;
  /** Full usage line shown by `<command> --help`. */
  usage?: string;
  run(args: readonly string[], context: CliCommandContext): Promise<number> | number;
}
