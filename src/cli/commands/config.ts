import type { CliCommand } from '../types';

export const configCommand: CliCommand = {
  name: 'config',
  description: 'View or edit configuration',
  usage: 'cadet-brainstem config',
  run(): number {
    console.log(
      '[cadet-brainstem] config: not implemented yet (wired in Task 16).',
    );
    return 0;
  },
};
