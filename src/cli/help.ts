import type { CliCommand } from './types';

/** Top-level help shown with no args or `--help`. */
export function buildHelp(commands: readonly CliCommand[]): string {
  const lines = [
    'cadet-brainstem — Cadet Brainstem CLI',
    '',
    'Usage:',
    '  cadet-brainstem <command> [options]',
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
    'Run "cadet-brainstem <command> --help" for command details.',
  ];
  return lines.join('\n');
}

/** Help shown for `<command> --help`. */
export function buildCommandHelp(command: CliCommand): string {
  return [
    `cadet-brainstem ${command.name} — ${command.description}`,
    '',
    'Usage:',
    `  ${command.usage ?? `cadet-brainstem ${command.name}`}`,
  ].join('\n');
}

/** Help shown for `cadet-brainstem telemetry` with no subcommand. */
export const TELEMETRY_HELP = [
  'cadet-brainstem telemetry — Manage anonymous telemetry',
  '',
  'Usage:',
  '  cadet-brainstem telemetry <status|on|off>',
  '',
  'Commands:',
  '  status   Show current telemetry setting',
  '  on       Enable anonymous telemetry',
  '  off      Disable anonymous telemetry',
].join('\n');
