import type { CliCommand } from './types';

/** Top-level help shown with no args or `--help`. */
export function buildHelp(commands: readonly CliCommand[]): string {
  const lines = [
    'cadet-token-saver — Cadet Token Saver CLI',
    '',
    'Usage:',
    '  cadet-token-saver <command> [options]',
    '',
    'Commands:',
    ...commands.map(
      (command) => `  ${command.name.padEnd(12)} ${command.description}`,
    ),
    '',
    'Options:',
    '  --version   Print version',
    '  --help      Show this help',
    '',
    'Run "cadet-token-saver <command> --help" for command details.',
  ];
  return lines.join('\n');
}

/** Help shown for `<command> --help`. */
export function buildCommandHelp(command: CliCommand): string {
  return [
    `cadet-token-saver ${command.name} — ${command.description}`,
    '',
    'Usage:',
    `  ${command.usage ?? `cadet-token-saver ${command.name}`}`,
  ].join('\n');
}

/** Help shown for `cadet-token-saver telemetry` with no subcommand. */
export const TELEMETRY_HELP = [
  'cadet-token-saver telemetry — Manage anonymous telemetry',
  '',
  'Usage:',
  '  cadet-token-saver telemetry <status|on|off>',
  '',
  'Commands:',
  '  status   Show current telemetry setting',
  '  on       Enable anonymous telemetry',
  '  off      Disable anonymous telemetry',
].join('\n');
