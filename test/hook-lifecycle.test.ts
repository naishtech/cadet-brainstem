import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
import { ProcedureStore } from '../src/procedure';

let dir: string;
let metricsPath: string;
let memoryPath: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-hooklc-'));
  metricsPath = join(dir, 'metrics.db');
  memoryPath = join(dir, 'memory.db');
  stateDir = join(dir, 'hooks');
  // Write a controlled config so tests never touch the real user config.
  const cfgFile = join(dir, 'config.yaml');
  writeFileSync(cfgFile, 'classifier:\n  model: qwen3:4b\n', 'utf8');
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

  it('injects a matched procedure handoff into the context', async () => {
    const procPath = join(dir, 'proc.db');
    process.env.CADET_BRAINSTEM_PROCEDURES = procPath;
    try {
      const store = new ProcedureStore(procPath);
      store.seedProcedure({
        triggerPattern: 'Run diagnostics on a file',
        keywords: ['diagnostics', 'lint', 'errors'],
        steps: [{ service: 'serena', tool: 'get_diagnostics_for_file' }],
        riskTier: 'auto_execute',
        handoffShape:
          'call get_diagnostics_for_file with { relative_path: "<path>" }',
      });
      store.close();
      const { deps, outputs } = makeDeps(
        sessionPayload('s1', { prompt: 'run diagnostics on the file' }),
        {
          classify: async () => ({
            classification: {
              task: 'review',
              context_need: 'targeted',
              complexity: 'low',
              risk: 'low',
              precision: 'normal',
              entities: ['diagnostics', 'file'],
              guidance: '',
              tool_plan: { recommended_tools: [] },
              response_policy: { directives: [] },
            },
            degraded: false,
          }),
        },
      );
      const exit = await runHookUserPrompt(deps);
      expect(exit).toBe(0);
      const out = JSON.parse(outputs[0]!);
      expect(out.hookSpecificOutput.additionalContext).toContain('- procedures:');
      expect(out.hookSpecificOutput.additionalContext).toContain('Run diagnostics on a file');
      expect(out.hookSpecificOutput.additionalContext).toContain('get_diagnostics_for_file');
    } finally {
      delete process.env.CADET_BRAINSTEM_PROCEDURES;
    }
  });

  it('publishes request/response/stats.updated to the dashboard', async () => {
    const published: Array<{ type: string }> = [];
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
            entities: ['refactor'],
            guidance: '',
            tool_plan: { recommended_tools: [] },
            response_policy: { directives: [] },
          },
          degraded: false,
        }),
        publishEvents: async (events) => {
          published.push(...events.map((e) => ({ type: e.type })));
        },
      },
    );
    const exit = await runHookUserPrompt(deps);
    expect(exit).toBe(0);
    const types = published.map((e) => e.type);
    expect(types[0]).toBe('request');
    expect(types).toContain('response');
    expect(types).toContain('stats.updated');
    expect(outputs[0]).toBeDefined();
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

  it('publishes request/response/stats.updated to the dashboard', async () => {
    const published: Array<{ type: string }> = [];
    const { deps } = makeDeps(
      sessionPayload('s1', { tool_name: 'grep_search', tool_output: 'x' }),
      {
        publishEvents: async (events) => {
          published.push(...events.map((e) => ({ type: e.type })));
        },
      },
    );
    const exit = await runHookPostTool(deps);
    expect(exit).toBe(0);
    const types = published.map((e) => e.type);
    expect(types[0]).toBe('request');
    expect(types).toContain('response');
    expect(types).toContain('stats.updated');
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
