import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContextOptimizer } from '../../core';

const exec = promisify(execCb);

export const RTK_BIN = 'rtk';

export interface RtkOptimizeRequest {
  /** Shell command to run through RTK, e.g. "git status". */
  command: string;
  /** Working directory to run in. */
  cwd?: string;
  /**
   * Shell to run the command in. Defaults to the platform shell (cmd.exe on
   * Windows) — pass e.g. "bash" to run in git-bash. 
   */
  shell?: string;
}

export interface RtkResult {
  command: string;
  /** Original full output — always kept, never destroyed. */
  rawOutput: string;
  /** RTK-reduced output. */
  optimisedOutput: string;
  rawOutputSize: number;
  optimisedOutputSize: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  estimatedTokensSaved: number;
  timestamp: string;
  /** True when RTK was unavailable/errored and the normal path was used. */
  degraded: boolean;
}

async function runShell(
  command: string,
  cwd?: string,
  shell?: string,
): Promise<string> {
  const { stdout, stderr } = await exec(command, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(shell !== undefined ? { shell } : {}),
  });
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

const estimateTokens = (bytes: number): number => Math.round(bytes / 4);

/**
 * RTK adapter (design doc §5). Reduces noisy terminal output before it becomes
 * agent context by running the command through RTK. The original output is
 * always captured and recoverable. It orchestrates RTK — never reimplements it.
 *
 * Note: `optimize()` runs the command twice (once raw, once through RTK) so it
 * is best suited to read-only/status commands (git status, ls, grep, tests).
 */
export class RtkAdapter implements ContextOptimizer {
  readonly name = 'rtk';

  async isAvailable(): Promise<boolean> {
    try {
      await exec(`${RTK_BIN} --version`, { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Run `command`, return the raw and RTK-optimised outputs + metrics. */
  async optimize(request: RtkOptimizeRequest): Promise<RtkResult> {
    const timestamp = new Date().toISOString();
    const available = await this.isAvailable();

    const rawOutput = await runShell(request.command, request.cwd, request.shell);
    const rawOutputSize = Buffer.byteLength(rawOutput);
    const tokensBefore = estimateTokens(rawOutputSize);

    const fallback = (): RtkResult => ({
      command: request.command,
      rawOutput,
      optimisedOutput: rawOutput,
      rawOutputSize,
      optimisedOutputSize: rawOutputSize,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensBefore,
      estimatedTokensSaved: 0,
      timestamp,
      degraded: true,
    });

    if (!available) {
      return fallback();
    }

    let optimisedOutput: string;
    try {
      optimisedOutput = await runShell(
        `${RTK_BIN} ${request.command}`,
        request.cwd,
        request.shell,
      );
    } catch {
      // RTK failed → transparent fallback to the normal command path.
      return fallback();
    }

    const optimisedOutputSize = Buffer.byteLength(optimisedOutput);
    const tokensAfter = estimateTokens(optimisedOutputSize);
    return {
      command: request.command,
      rawOutput,
      optimisedOutput,
      rawOutputSize,
      optimisedOutputSize,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
      estimatedTokensSaved: Math.max(0, tokensBefore - tokensAfter),
      timestamp,
      degraded: false,
    };
  }

  async install(): Promise<void> {
    // Never auto-install — surface the documented command instead.
    console.log(
      '[cadet-token-saver] rtk not installed. See https://github.com/naishtech/cadet-token-saver/blob/main/docs/requirements.md — on Windows download ' +
        'rtk-x86_64-pc-windows-msvc.zip and add rtk.exe to your PATH.',
    );
  }

  async configure(): Promise<void> {
    // RTK needs no Cadet Token Saver configuration.
  }
}
