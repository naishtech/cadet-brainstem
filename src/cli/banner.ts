/**
 * Coloured bold banner for the CLI. Deliberately simple — no ASCII art
 * generation, just bold coloured text (ANSI SGR).
 */
const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

export const INIT_BANNER = [
  `${BOLD}${CYAN}CADET TOKEN $AVER${RESET}`,
  `${DIM}local context optimisation for AI coding agents${RESET}`,
].join('\n');
