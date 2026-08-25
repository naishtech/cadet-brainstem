import type { CliCommand } from '../types';

export const doctorCommand: CliCommand = {
  name: 'doctor',
  description: 'Check environment health',
  usage: 'cadet-token-saver doctor',
  run(): number {
    console.log(
      '[cadet-token-saver] doctor: not implemented yet (wired in Task 15).',
    );
    return 0;
  },
};
