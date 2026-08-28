import type { CliCommand } from '../types';

export const dashboardCommand: CliCommand = {
  name: 'dashboard',
  description: 'Open the local metrics dashboard',
  usage: 'cadet-brainstem dashboard',
  run(): number {
    console.log(
      '[cadet-brainstem] dashboard: not implemented yet (wired in Task 18).',
    );
    return 0;
  },
};
