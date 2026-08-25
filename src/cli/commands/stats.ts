import type { CliCommand } from '../types';

export const statsCommand: CliCommand = {
  name: 'stats',
  description: 'Show saved/processed token metrics',
  usage: 'cadet-token-saver stats',
  run(): number {
    console.log(
      '[cadet-token-saver] stats: not implemented yet (wired in Task 17).',
    );
    return 0;
  },
};
