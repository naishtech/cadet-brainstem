import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autoBuildClassifier,
  cleanupSessionState,
  runHookPostTool,
  runHookPreCompact,
  runHookSessionStart,
  runHookStop,
  runHookSubagentStart,
  runHookSubagentStop,
  runHookUserPrompt,
  type HookLifecycleDeps,
} from '../src/cli/commands/hook-lifecycle';
import { MemoryStore } from '../src/memory';
import { MetricsStore } from '../src/metrics';

let dir: string;
let metricsPath: string;
let memoryPath: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-hooklc-'));
  metricsPath = join(dir, 'metrics.db');
  memoryPath = join(dir, 'memory.db');
  stateDir = join(dir, 'hooks');
  // Isolate auto-build tests from any real user config: write a controlled
  // config where the base model (qwen3:1.7b) is present and the derived
  // fast-classifier is absent, so the auto-build path is exercised.
  const cfgFile = join(dir, 'config.yaml');
  writeFileSync(
    cfgFile,
    'classifier:\n  model: qwen3:1.7b\n  derived_model: fast-classifier:latest\n  auto_build: true\n',
    'utf8',
  );
  process.env.CADET_BRAINSTEM_CONFIG = cfgFile;
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(
  payload: string,
  overrides: Partial<HookLifecycleDeps> = {},
): { deps: HookLifecycleDeps; outputs: string[] } {
  const outputs: string[] = [];
  const deps: HookLifecycleDeps = {
    readStdin: async () => payload,
    writeOut: (line) => outputs.push(line),
    metricsPath,
    memoryPath,
    stateDir,
    resolveProject: (cwd) => cwd,
    // Skip the auto-build by default so unit tests never touch Ollama/config.
    autoBuild: false,
    ...overrides,
  };
  return { deps, outputs };
}

function sessionPayload(sessionId = 's1', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: sessionId, cwd: dir, ...extra });
}

describe('runHookSessionStart', () => {
  it('injects a primer with the recommended tool and session start marker', async () => {
    const { deps, outputs } = makeDeps(sessionPayload());
    const exit = await runHookSessionStart(deps, 'find_relevant_symbols');
    expect(exit).toBe(0);
    const out = JSON.parse(outputs[0]!);
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput.additionalContext).toContain('find_relevant_symbols');
    expect(out.hookSpecificOutput.additionalContext).toContain('Session start');
  });

  it('runs the auto-build and still emits the primer', async () => {
    const built: string[] = [];
    const { deps, outputs } = makeDeps(sessionPayload(), {
      autoBuild: true,
      classifierAvailable: async (model) => model === 'qwen3:1.7b',
      buildClassifier: async (base) => {
        built.push(base);
        return { ok: true };
      },
    });
    const exit = await runHookSessionStart(deps, 'find_relevant_symbols');
    expect(exit).toBe(0);
    expect(built).toEqual(['qwen3:1.7b']);
    const out = JSON.parse(outputs[0]!);
    expect(out.hookSpecificOutput.additionalContext).toContain('Session start');
  });
});

describe('autoBuildClassifier', () => {
  it('builds the derived classifier when missing and the base model is present', async () => {
    const calls: string[] = [];
    const { deps } = makeDeps(sessionPayload(), {
      autoBuild: true,
      // derived (fast-classifier) missing, base (qwen3:1.7b) present
      classifierAvailable: async (model) => model === 'qwen3:1.7b',
      buildClassifier: async (base) => {
        calls.push(base);
        return { ok: true };
      },
    });
    await autoBuildClassifier(deps);
    expect(calls).toEqual(['qwen3:1.7b']);
  });

  it('skips the build when the derived classifier is already present', async () => {
    const calls: string[] = [];
    const { deps } = makeDeps(sessionPayload(), {
      autoBuild: true,
      classifierAvailable: async () => true,
      buildClassifier: async (base) => {
        calls.push(base);
        return { ok: true };
      },
    });
    await autoBuildClassifier(deps);
    expect(calls).toEqual([]);
  });

  it('skips the build when the base model is absent', async () => {
    const calls: string[] = [];
    const { deps } = makeDeps(sessionPayload(), {
      autoBuild: true,
      classifierAvailable: async () => false,
      buildClassifier: async (base) => {
        calls.push(base);
        return { ok: true };
      },
    });
    await autoBuildClassifier(deps);
    expect(calls).toEqual([]);
  });

  it('does nothing when autoBuild is disabled', async () => {
    const calls: string[] = [];
    const { deps } = makeDeps(sessionPayload(), {
      autoBuild: false,
      classifierAvailable: async () => {
        calls.push('available-check');
        return false;
      },
      buildClassifier: async (base) => {
        calls.push(base);
        return { ok: true };
      },
    });
    await autoBuildClassifier(deps);
    expect(calls).toEqual([]);
  });

  it('never throws when the build fails', async () => {
    const { deps } = makeDeps(sessionPayload(), {
      autoBuild: true,
      classifierAvailable: async (model) => model === 'qwen3:1.7b',
      buildClassifier: async () => {
        throw new Error('boom');
      },
    });
    await expect(autoBuildClassifier(deps)).resolves.toBeUndefined();
  });
});

describe('runHookUserPrompt', () => {
  it('injects a classified strategy for a non-empty prompt', async () => {
    const { deps, outputs } = makeDeps(
      sessionPayload('s1', { prompt: 'refactor the auth module' }),
      {
        classify: async () => ({
          classification: {
            task: 'refactor',
            context_need: 'targeted',
            complexity: 'medium',
            risk: 'medium',
            precision: 'normal',
            entities: ['refactor', 'inventory'],
            guidance: 'prefer semantic search',
            tool_plan: {
              recommended_tools: [
                { name: 'find_relevant_symbols', intent: 'locate relevant symbols', priority: 1 },
              ],
            },
            response_policy: { directives: ['delta_only'] },
          },
          degraded: false,
        }),
      },
    );
    const exit = await runHookUserPrompt(deps);
    expect(exit).toBe(0);
    const out = JSON.parse(outputs[0]!);
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput.additionalContext).toContain('Classified request');
    expect(out.hookSpecificOutput.additionalContext).toContain('find_relevant_symbols');
  });

  it('is a no-op when no prompt is present', async () => {
    const { deps, outputs } = makeDeps(sessionPayload());
    const exit = await runHookUserPrompt(deps);
    expect(exit).toBe(0);
    const out = JSON.parse(outputs[0]!);
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});

describe('runHookPostTool', () => {
  it('records a metrics row and continues', async () => {
    const { deps, outputs } = makeDeps(
      sessionPayload('s1', {
        tool_name: 'grep_search',
        tool_output: 'a'.repeat(2000),
      }),
    );
    const exit = await runHookPostTool(deps);
    expect(exit).toBe(0);
    expect(JSON.parse(outputs[0]!).continue).toBe(true);
    const store = new MetricsStore(metricsPath);
    const totals = store.getTotals();
    store.close();
    expect(totals.eventCount).toBeGreaterThan(0);
  });
});

describe('runHookPreCompact', () => {
  it('stores a memory checkpoint and injects a preserve-evidence reminder', async () => {
    const { deps, outputs } = makeDeps(sessionPayload());
    const exit = await runHookPreCompact(deps);
    expect(exit).toBe(0);
    const out = JSON.parse(outputs[0]!);
    expect(out.hookSpecificOutput.additionalContext).toContain('compacted');
    const store = new MemoryStore(memoryPath);
    const memories = store.list({ project: dir });
    store.close();
    expect(memories.some((m) => m.content.includes('Pre-compact'))).toBe(true);
  });
});

describe('runHookSubagentStart / Stop', () => {
  it('injects a cheap-path primer and records usage', async () => {
    const { deps, outputs } = makeDeps(sessionPayload());
    await runHookSubagentStart(deps);
    const out = JSON.parse(outputs[0]!);
    expect(out.hookSpecificOutput.additionalContext).toContain('cheap path');
  });

  it('cleans up state on stop', async () => {
    const { deps, outputs } = makeDeps(sessionPayload('s1'));
    await runHookSubagentStop(deps);
    expect(JSON.parse(outputs[0]!).continue).toBe(true);
  });
});

describe('runHookStop', () => {
  it('stores a session summary and cleans up', async () => {
    const { deps, outputs } = makeDeps(sessionPayload('s1'));
    const exit = await runHookStop(deps);
    expect(exit).toBe(0);
    expect(JSON.parse(outputs[0]!).continue).toBe(true);
    const store = new MemoryStore(memoryPath);
    const memories = store.list({ project: dir });
    store.close();
    expect(memories.some((m) => m.content.includes('ended'))).toBe(true);
  });
});

describe('cleanupSessionState', () => {
  it('removes persisted counter state for a session', async () => {
    // create fake state files
    const { deps } = makeDeps(sessionPayload());
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(stateDir, 's99'), { recursive: true });
    writeFileSync(join(stateDir, 's99.json'), '{}');
    cleanupSessionState('s99', deps);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(stateDir, 's99'))).toBe(false);
    expect(existsSync(join(stateDir, 's99.json'))).toBe(false);
  });
});
