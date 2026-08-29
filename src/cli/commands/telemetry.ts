import { TELEMETRY_HELP } from '../help';
import type { CliCommand } from '../types';

function stub(subcommand: string): number {
  console.log(
    `[cadet-brainstem] telemetry ${subcommand}: not implemented yet (wired in a later task).`,
  );
  return 0;
}

export const telemetryCommand: CliCommand = {
  name: 'telemetry',
  description: 'Manage anonymous telemetry (status | on | off)',
  usage: 'cadet-brainstem telemetry <status|on|off>',
  run(args: readonly string[]): number {
    const sub = args[0];
    if (sub === undefined || sub === '--help' || sub === '-h') {
      console.log(TELEMETRY_HELP);
      return 0;
    }
    switch (sub) {
      case 'status':
        return stub('status');
      case 'on':
        return stub('on');
      case 'off':
        return stub('off');
      default:
        console.error(
          `cadet-brainstem telemetry: unknown subcommand "${sub}"`,
        );
        console.error(TELEMETRY_HELP);
        return 1;
    }
  },
};
