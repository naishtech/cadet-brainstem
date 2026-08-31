import { warmUpOllama } from '../../steering';
import type { CliCommand } from '../types';

export interface WarmOptions {
  host?: string;
  model?: string;
  keepAlive?: string | number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Warm up the local LLM on demand (e.g. from a VS Code startup task or to test
 * `keep_alive` settings). Forces the configured model to load so the first real
 * steer call is fast. Returns the process exit code (0 = success).
 */
export async function runWarm(options: WarmOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  log('Warming up the local LLM (Ollama)…');
  const result = await warmUpOllama(options);
  if (result.ok) {
    log(`✓ Local LLM warm (${result.latencyMs}ms)`);
    return 0;
  }
  log(`✗ Warm-up failed: ${result.error ?? 'unknown error'}`);
  return 1;
}

export const warmCommand: CliCommand = {
  name: 'warm',
  description: 'Warm up the local LLM (load the model)',
  usage: 'cadet-brainstem warm [--keep-alive <dur|-1>] [--model <name>]',
  run(args: readonly string[]): Promise<number> {
    let keepAlive: string | number | undefined;
    let model: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--keep-alive') {
        const raw = args[++i];
        if (raw !== undefined) keepAlive = Number.isNaN(Number(raw)) ? raw : Number(raw);
      } else if (a === '--model') {
        model = args[++i];
      }
    }
    const options: WarmOptions = {};
    if (keepAlive !== undefined) options.keepAlive = keepAlive;
    if (model !== undefined) options.model = model;
    return runWarm(options);
  },
};
