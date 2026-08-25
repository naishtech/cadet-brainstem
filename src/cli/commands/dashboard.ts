import type { CliCommand } from '../types';

export const dashboardCommand: CliCommand = {
  name: 'dashboard',
  description: 'Open the local metrics dashboard',
  usage: 'cadet-token-saver dashboard',
  run(): number {
    console.log(
      '[cadet-token-saver] dashboard: not implemented yet (wired in Task 18).',
    );
    return 0;
  },
};
