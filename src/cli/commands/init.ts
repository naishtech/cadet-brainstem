import type { CliCommand } from '../types';

export const initCommand: CliCommand = {
  name: 'init',
  description: 'Set up configuration and integrations (first run)',
  usage: 'cadet-token-saver init',
  run(): number {
    console.log(
      '[cadet-token-saver] init: not implemented yet (wired in Task 14).',
    );
    return 0;
  },
};
