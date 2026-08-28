import {
  getDefaultMetricsPath,
  MetricsStore,
  type OptimisationEvent,
} from '../../metrics';
import { RtkAdapter, type RtkResult } from '../../integrations/rtk';
import type { CliCommand } from '../types';

export interface WrapDeps {
  /** Override the RTK adapter (tests). */
  rtk?: Pick<RtkAdapter, 'optimize'>;
  /** Override the metrics db path (tests). */
  metricsPath?: string;
  /** Override the output sink (tests). */
  log?: (line: string) => void;
}

export interface WrapOptions {
  /** Print the full raw output instead of the reduced output. */
  raw?: boolean;
  /** Working directory to run the command in. */
  cwd?: string;
  /** Shell to run the command in (defaults to the platform shell, cmd.exe on Windows). */
  shell?: string;
}

export interface ParsedWrapArgs {
  command?: string;
  raw: boolean;
  shell?: string;
}

/**
 * Parse `wrap` arguments. Everything after a `--` separator (or any
 * non-flag argument) is treated as the command, so command flags like
 * `git status --short` are preserved. `--raw` / `-r` and `--shell <name>`
 * are wrap flags (they must appear before `--`).
 */
export function parseWrapArgs(args: readonly string[]): ParsedWrapArgs {
  let raw = false;
  let shell: string | undefined;
  let afterSeparator = false;
  const commandTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (afterSeparator) {
      commandTokens.push(arg);
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg === '--raw' || arg === '-r') {
      raw = true;
      continue;
    }
    if (arg === '--shell') {
      const value = args[i + 1];
      if (value !== undefined) {
        shell = value;
        i += 1;
      }
      continue;
    }
    commandTokens.push(arg);
  }
  const command =
    commandTokens.length > 0 ? commandTokens.join(' ') : undefined;
  return {
    raw,
    ...(command !== undefined ? { command } : {}),
    ...(shell !== undefined ? { shell } : {}),
  };
}

function recordWrapEvent(metricsPath: string, result: RtkResult): void {
  const event: OptimisationEvent = {
    timestamp: result.timestamp,
    session_id: 'cli',
    task_type: 'investigation',
    complexity: 'low',
    risk: 'low',
    tool: 'rtk',
    operation: 'wrap',
    estimated_input_tokens: result.estimatedTokensBefore,
    estimated_output_tokens: result.estimatedTokensAfter,
    estimated_tokens_saved: result.estimatedTokensSaved,
    compression_ratio:
      result.rawOutputSize > 0
        ? result.optimisedOutputSize / result.rawOutputSize
        : null,
    optimisation_strategy: null,
  };
  try {
    const store = new MetricsStore(metricsPath);
    store.record(event);
    store.close();
  } catch (err) {
    // Metrics is best-effort — a failure never breaks the wrap.
    console.error(
      `[cadet-brainstem] metrics record skipped: ${(err as Error).message}`,
    );
  }
}

/**
 * Run a command and print its RTK-reduced output (design doc §5, Task 26).
 * The full raw output is always captured by the adapter and is recoverable by
 * re-running with `--raw`. Falls back to the original output when RTK is
 * unavailable (the adapter's `degraded` path).
 */
export async function runWrap(
  command: string,
  options: WrapOptions = {},
  deps: WrapDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const rtk = deps.rtk ?? new RtkAdapter();
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();

  const result = await rtk.optimize({
    command,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.shell !== undefined ? { shell: options.shell } : {}),
  });
  recordWrapEvent(metricsPath, result);
  if (result.estimatedTokensSaved === 0 && !result.degraded) {
    console.error(
      '[cadet-brainstem] nothing to compress — output is small or already compact (0 tokens saved).',
    );
  }
  log(options.raw ? result.rawOutput : result.optimisedOutput);
  return 0;
}

export const wrapCommand: CliCommand = {
  name: 'wrap',
  description: 'Run a command and print its RTK-reduced output',
  usage: 'cadet-brainstem wrap [--raw] [--shell <name>] -- <command>',
  run(args: readonly string[]): Promise<number> {
    const { command, raw, shell } = parseWrapArgs(args);
    if (command === undefined || command.length === 0) {
      console.error('[cadet-brainstem] wrap: missing command.');
      console.error('Usage: cadet-brainstem wrap [--raw] [--shell <name>] -- <command>');
      return Promise.resolve(1);
    }
    return runWrap(command, {
      raw,
      ...(shell !== undefined ? { shell } : {}),
    });
  },
};
