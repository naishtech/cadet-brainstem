import { readFileSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContextOptimizer } from '../../core';
import type { LeanCtxMode } from '../../policy/schema';

const execFile = promisify(execFileCb);

export const LEAN_CTX_BIN = 'lean-ctx';

/**
 * Map the design-doc LeanCTX modes (the policy's `leanctx_mode`) to the CLI's
 * `lean-ctx read <file> -m <mode>` read modes. Modes LeanCTX does not expose
 * directly are mapped to the nearest supported equivalent.
 */
export const LEAN_CTX_MODE_MAP: Record<LeanCtxMode, string> = {
  full: 'full',
  raw: 'full', // raw = full uncompressed content
  lines: 'lines', // requires a range; resolved in resolveCliMode
  diff: 'diff',
  reference: 'reference',
  signatures: 'signatures',
  map: 'map',
  cognitive: 'entropy', // nearest supported read mode
  task: 'task',
  density: 'aggressive', // nearest supported read mode
  aggressive: 'aggressive',
};

export interface LeanCtxOptimizeRequest {
  /** File/path whose context should be compiled. */
  target: string;
  /** Mode from the policy engine (Task 07). */
  mode: LeanCtxMode;
  /** Classification from the classifier, recorded in metrics. */
  taskType: string;
  /** Optional token budget (reserved; used by the compile path in future). */
  budget?: number;
  /** Line range for the `lines` mode, e.g. "10-50". */
  lines?: string;
}

export interface LeanCtxResult {
  context: string;
  sourceSize: number;
  returnedSize: number;
  mode: string;
  estimatedTokensSaved: number;
  taskType: string;
  degraded: boolean;
}

/** Resolve the CLI read-mode string for a request. */
export function resolveCliMode(request: LeanCtxOptimizeRequest): string {
  if (request.mode === 'lines' && request.lines !== undefined) {
    return `lines:${request.lines}`;
  }
  return LEAN_CTX_MODE_MAP[request.mode];
}

async function runLeanCtx(args: string[]): Promise<string> {
  const { stdout } = await execFile(LEAN_CTX_BIN, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/**
 * LeanCTX adapter (design doc §7). Treats LeanCTX as the context compiler:
 * Cadet Token Saver decides what context a task needs (mode from the policy);
 * LeanCTX decides the representation. This adapter only passes mode/budget
 * through — it never reproduces LeanCTX's algorithms.
 */
export class LeanCtxAdapter implements ContextOptimizer {
  readonly name = 'leanctx';

  async isAvailable(): Promise<boolean> {
    try {
      await execFile(LEAN_CTX_BIN, ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Return a context representation for `target` via LeanCTX. */
  async optimize(request: LeanCtxOptimizeRequest): Promise<LeanCtxResult> {
    const source = readFileSync(request.target, 'utf8');
    const sourceSize = Buffer.byteLength(source);

    let output: string;
    let mode: string;
    try {
      mode = resolveCliMode(request);
      output = await runLeanCtx(['read', request.target, '-m', mode]);
    } catch {
      // Graceful fallback: return the unoptimised context, no data loss.
      return {
        context: source,
        sourceSize,
        returnedSize: sourceSize,
        mode: 'raw',
        estimatedTokensSaved: 0,
        taskType: request.taskType,
        degraded: true,
      };
    }

    const returnedSize = Buffer.byteLength(output);
    return {
      context: output,
      sourceSize,
      returnedSize,
      mode,
      estimatedTokensSaved: Math.max(0, Math.round((sourceSize - returnedSize) / 4)),
      taskType: request.taskType,
      degraded: false,
    };
  }

  async install(): Promise<void> {
    // Never auto-install — surface the documented command instead.
    console.log(
      '[cadet-token-saver] leanctx not installed. See https://github.com/naishtech/cadet-token-saver/blob/main/docs/requirements.md — on Windows download ' +
        'lean-ctx-x86_64-pc-windows-msvc.zip and add lean-ctx.exe to your PATH.',
    );
  }

  async configure(): Promise<void> {
    await runLeanCtx(['doctor']).catch(() => undefined);
  }
}
