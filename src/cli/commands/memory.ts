import { getDefaultMemoryPath, MemoryStore } from '../../memory';
import type { CliCommand } from '../types';
import { askYesNo } from './init';

export interface MemoryDeps {
  /** Override the memory db path (tests). */
  memoryPath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
  /** Confirmation prompt (tests). Defaults to askYesNo. */
  ask?: (question: string) => Promise<boolean>;
}

/**
 * `memory clear` — empty the memory database after an explicit confirmation.
 * Non-interactive (or declined) runs clear nothing. Truncates rows only; the
 * database file and table remain intact.
 */
export async function runMemoryClear(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = deps.ask ?? askYesNo;
  const memoryPath = deps.memoryPath ?? getDefaultMemoryPath();

  let store: MemoryStore;
  try {
    store = new MemoryStore(memoryPath);
  } catch (err) {
    log(
      `[cadet-token-saver] memory clear: could not open memory database at ${memoryPath}`,
    );
    log(`  ${(err as Error).message}`);
    return 1;
  }

  try {
    const count = store.count();
    log('');
    log(`Memory database: ${memoryPath}`);
    log(`Will clear ${count} stored memory entries.`);
    const confirmed = await ask('Clear ALL memories? This cannot be undone. [y/N]');
    if (!confirmed) {
      log('Aborted — no data was cleared.');
      return 0;
    }
    const removed = store.clear();
    log(`Cleared ${removed} memory entries.`);
    return 0;
  } finally {
    store.close();
  }
}

export const memoryCommand: CliCommand = {
  name: 'memory',
  description: 'Manage agent memories (clear)',
  usage: 'cadet-token-saver memory clear',
  run(args: readonly string[]): Promise<number> | number {
    if (args[0] === 'clear') {
      return runMemoryClear();
    }
    console.error('Usage: cadet-token-saver memory clear');
    return 1;
  },
};
