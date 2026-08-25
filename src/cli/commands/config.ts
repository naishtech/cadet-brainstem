import type { CliCommand } from '../types';

export const configCommand: CliCommand = {
  name: 'config',
  description: 'View or edit configuration',
  usage: 'cadet-token-saver config',
  run(): number {
    console.log(
      '[cadet-token-saver] config: not implemented yet (wired in Task 16).',
    );
    return 0;
  },
};
