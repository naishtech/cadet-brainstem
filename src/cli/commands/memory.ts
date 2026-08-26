import { existsSync, statSync } from 'node:fs';
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * `memory` (no subcommand) — show the memory metrics: row count + database
 * file size (design doc §17).
 */
export async function runMemoryStats(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const memoryPath = deps.memoryPath ?? getDefaultMemoryPath();

  log('');
  log('Cadet Token Saver Memory');
  log('------------------------');
  log(`Memory database: ${memoryPath}`);

  if (!existsSync(memoryPath)) {
    log('');
    log('No memories stored yet.');
    log('Use the MCP `chat_memory_store` tool (store) to persist memories.');
    return 0;
  }

  let store: MemoryStore;
  try {
    store = new MemoryStore(memoryPath);
  } catch (err) {
    log(`  could not open: ${(err as Error).message}`);
    return 1;
  }

  try {
    const count = store.count();
    log(`Memories: ${count.toLocaleString('en-US')}`);
    log(`Size:     ${formatBytes(statSync(memoryPath).size)}`);
    return 0;
  } finally {
    store.close();
  }
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
    const confirmed = await ask('Clear ALL memories? This cannot be undone.');
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
  description: 'Show/manage agent memories (clear to wipe them)',
  usage: 'cadet-token-saver memory [clear]',
  run(args: readonly string[]): Promise<number> | number {
    const first = args[0];
    if (first === undefined) {
      return runMemoryStats();
    }
    if (first === 'clear') {
      return runMemoryClear();
    }
    console.error('Usage: cadet-token-saver memory [clear]');
    return 1;
  },
};
