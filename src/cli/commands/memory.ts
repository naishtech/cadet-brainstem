import { existsSync, statSync } from 'node:fs';
import {
  GLOBAL_PROJECT,
  MemoryStore,
  resolveMemoryDbPath,
  resolveProjectId,
} from '../../memory';
import { loadConfig } from '../../config';
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
  /** Operate on the global store instead of a project. */
  global?: boolean;
  /** Working directory used to derive the project (tests). */
  cwd?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Resolve the memory db path and a human label for the scope. */
function resolveTarget(deps: MemoryDeps): { memoryPath: string; projectLabel: string } {
  const cwd = deps.cwd ?? process.cwd();
  const global = deps.global === true;
  const memoryPath =
    deps.memoryPath ??
    resolveMemoryDbPath(
      cwd,
      global ? GLOBAL_PROJECT : deps.project,
      loadConfig().memory.active_project,
      loadConfig().memory.projects,
    );
  const projectLabel = global
    ? 'global'
    : (deps.project ?? resolveProjectId(cwd));
  return { memoryPath, projectLabel };
}

/**
 * `memory` (no subcommand) — show the memory metrics for the current project:
 * row count + database file size (design doc §17).
 */
export async function runMemoryStats(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { memoryPath, projectLabel } = resolveTarget(deps);

  log('');
  log('Cadet Token Saver Memory');
  log('------------------------');
  log(`Memory database: ${memoryPath}`);
  log(`Project: ${projectLabel}`);

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
    log(`Memories: ${store.count().toLocaleString('en-US')}`);
    log(`Size:     ${formatBytes(statSync(memoryPath).size)}`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `memory clear` — empty the current project's memories (or the global store
 * with `--global`) after an explicit confirmation. Non-interactive (or
 * declined) runs clear nothing.
 */
export async function runMemoryClear(deps: MemoryDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = deps.ask ?? askYesNo;
  const { memoryPath, projectLabel } = resolveTarget(deps);

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
    log(`Project: ${projectLabel}`);
    log(`Will clear ${count} stored memory entries.`);
    const confirmed = await ask(
      `Clear ALL memories for project "${projectLabel}"? This cannot be undone.`,
    );
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

interface ParsedMemoryArgs {
  clear: boolean;
  global: boolean;
  project?: string;
}

/** Parse `memory` arguments; returns null for unknown arguments. */
function parseMemoryArgs(args: readonly string[]): ParsedMemoryArgs | null {
  const result: ParsedMemoryArgs = { clear: false, global: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      return null;
    }
    if (arg === 'clear') {
      result.clear = true;
    } else if (arg === '--global' || arg === '-g') {
      result.global = true;
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
  usage: 'cadet-token-saver memory [clear] [--project <name>] [--global]',
  run(
    args: readonly string[],
    context: CliCommandContext,
  ): Promise<number> | number {
    const parsed = parseMemoryArgs(args);
    if (parsed === null) {
      console.error(
        'Usage: cadet-token-saver memory [clear] [--project <name>] [--global]',
      );
      return 1;
    }
    if (parsed.clear) {
      return runMemoryClear({
        ...(parsed.project !== undefined ? { project: parsed.project } : {}),
        global: parsed.global,
        cwd: context.cwd,
      });
    }
    return runMemoryStats({
      ...(parsed.project !== undefined ? { project: parsed.project } : {}),
      global: parsed.global,
      cwd: context.cwd,
    });
  },
};


