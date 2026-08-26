import { existsSync, statSync } from 'node:fs';
import { getDefaultMemoryPath, MemoryStore, resolveProjectId } from '../../memory';
import type { CliCommand, CliCommandContext } from '../types';
import { askYesNo } from './init';

export interface MemoryDeps {
  /** Override the memory db path (tests). */
  memoryPath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
  /** Confirmation prompt (tests). Defaults to askYesNo. */
  ask?: (question: string) => Promise<boolean>;
  /** Override the project scope (tests); defaults to cwd-derived. */
  project?: string;
  /** Operate on every project, not just the current one. */
  all?: boolean;
  /** Working directory used to derive the project (tests). */
  cwd?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Resolve the project scope for an operation. */
function resolveScope(deps: MemoryDeps): { project: string; all: boolean } {
  const all = deps.all === true;
  const project = deps.project ?? resolveProjectId(deps.cwd ?? process.cwd());
  return { project, all };
}

/**
 * `memory` (no subcommand) — show the memory metrics for the current project:
 * row count + database file size (design doc §17).
 */
export async function runMemoryStats(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const memoryPath = deps.memoryPath ?? getDefaultMemoryPath();
  const { project } = resolveScope(deps);

  log('');
  log('Cadet Token Saver Memory');
  log('------------------------');
  log(`Memory database: ${memoryPath}`);
  log(`Project: ${project}`);

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
    const count = store.count(project);
    log(`Memories: ${count.toLocaleString('en-US')}`);
    log(`Size:     ${formatBytes(statSync(memoryPath).size)}`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `memory clear` — empty the current project's memories after an explicit
 * confirmation (or every project with `--all`). Non-interactive (or declined)
 * runs clear nothing.
 */
export async function runMemoryClear(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = deps.ask ?? askYesNo;
  const memoryPath = deps.memoryPath ?? getDefaultMemoryPath();
  const { project, all } = resolveScope(deps);

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
    const count = all ? store.count() : store.count(project);
    log('');
    log(`Memory database: ${memoryPath}`);
    log(`Project: ${all ? 'all' : project}`);
    log(`Will clear ${count} stored memory entries.`);
    const question = all
      ? 'Clear ALL memories (every project)? This cannot be undone.'
      : `Clear ALL memories for project "${project}"? This cannot be undone.`;
    const confirmed = await ask(question);
    if (!confirmed) {
      log('Aborted — no data was cleared.');
      return 0;
    }
    const removed = all ? store.clear() : store.clear(project);
    log(`Cleared ${removed} memory entries.`);
    return 0;
  } finally {
    store.close();
  }
}

interface ParsedMemoryArgs {
  clear: boolean;
  all: boolean;
  project?: string;
}

/** Parse `memory` arguments; returns null for unknown arguments. */
function parseMemoryArgs(args: readonly string[]): ParsedMemoryArgs | null {
  const result: ParsedMemoryArgs = { clear: false, all: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      return null;
    }
    if (arg === 'clear') {
      result.clear = true;
    } else if (arg === '--all' || arg === '-a') {
      result.all = true;
    } else if (arg === '--project') {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        return null;
      }
      result.project = value;
      i += 1;
    } else if (arg.startsWith('--project=')) {
      const value = arg.slice('--project='.length);
      if (value.length === 0) {
        return null;
      }
      result.project = value;
    } else {
      return null;
    }
  }
  return result;
}

export const memoryCommand: CliCommand = {
  name: 'memory',
  description: 'Show/manage agent memories (clear to wipe them)',
  usage: 'cadet-token-saver memory [clear] [--project <name>] [--all]',
  run(
    args: readonly string[],
    context: CliCommandContext,
  ): Promise<number> | number {
    const parsed = parseMemoryArgs(args);
    if (parsed === null) {
      console.error('Usage: cadet-token-saver memory [clear] [--project <name>] [--all]');
      return 1;
    }
    if (parsed.clear) {
      return runMemoryClear({
        ...(parsed.project !== undefined ? { project: parsed.project } : {}),
        all: parsed.all,
        cwd: context.cwd,
      });
    }
    return runMemoryStats({
      ...(parsed.project !== undefined ? { project: parsed.project } : {}),
      cwd: context.cwd,
    });
  },
};

