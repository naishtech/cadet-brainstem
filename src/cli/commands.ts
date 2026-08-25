import pkg from '../../package.json';
import { buildCommandHelp, buildHelp } from './help';
import type { CliCommand, CliCommandContext } from './types';
import { configCommand } from './commands/config';
import { dashboardCommand } from './commands/dashboard';
import { doctorCommand } from './commands/doctor';
import { initCommand } from './commands/init';
import { mcpCommand } from './commands/mcp';
import { statsCommand } from './commands/stats';
import { telemetryCommand } from './commands/telemetry';

export const VERSION: string = pkg.version;

export const COMMANDS: readonly CliCommand[] = [
  initCommand,
  doctorCommand,
  statsCommand,
  dashboardCommand,
  configCommand,
  telemetryCommand,
  mcpCommand,
];

const COMMAND_MAP: ReadonlyMap<string, CliCommand> = new Map(
  COMMANDS.map((command) => [command.name, command]),
);

/**
 * Parse argv and route to the matching subcommand module. Returns the process
 * exit code (0 = success, non-zero = error).
 */
export async function runCli(
  argv: readonly string[],
  context: CliCommandContext = { cwd: process.cwd() },
): Promise<number> {
  const args = [...argv];
  const first = args[0];

  if (first === undefined || first === '--help' || first === '-h') {
    console.log(buildHelp(COMMANDS));
    return 0;
  }

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return 0;
  }

  const command = COMMAND_MAP.get(first);
  if (command === undefined) {
    console.error(`cadet-token-saver: unknown command "${first}"`);
    console.error('Run "cadet-token-saver --help" for usage.');
    return 1;
  }

  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(buildCommandHelp(command));
    return 0;
  }

  return await command.run(rest, context);
}
