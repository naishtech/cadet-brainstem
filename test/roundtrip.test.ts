import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatMemoryStoreTool,
  steerTool,
  compressCommandOutputTool,
  findRelevantSymbolsTool,
  handleToolCall,
  optimizeContextTool,
  type McpDeps,
} from '../src/mcp';
import { runStats } from '../src/cli/commands/stats';
import type { SteeringOutcome } from '../src/steering';
import type { OptimisationStrategy } from '../src/policy';
import { MemoryStore } from '../src/memory';

/**
 * Integration (round-trip) test: make a real call through the MCP tool dispatch
 * for every cadet service (steer, optimize_context, find_relevant_symbols,
 * compress_command_output, chat_memory_store), then verify `stats` reports the
 * tokens actually saved.
 *
 * The adapters for the external services (LeanCTX / RTK / Serena) are injected
 * with deterministic outputs so the run is hermetic and the expected savings are
 * exact — but the tool handlers, the metrics recording, and the stats aggregation
 * are all the real code, exercised end-to-end.
 */

function makeSteering(): SteeringOutcome {
  return {
    steering: {
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      entities: ['loader', 'debug'],
      tool_plan: {
        recommended_tools: [
          { name: 'optimize_context', intent: 'extract debug context', priority: 1 },
        ],
      },
      response_policy: { directives: ['compact', 'delta_only'], language_standard: 'microsoft' },
      guidance: 'trace the loader debug path',
      reminders: [{ tool: 'rtk', message: 'Use RTK for git output' }],
      subtasks: ['coding_new'],
      evidence_plan: {
        prioritized_queries: [{ id: 'q1', query: 'loader', sources: ['serena'], cost_estimate: 'cheap' }],
        scope: 'src/loader',
      },
      memory: { use: 'if_necessary', reason: 'check prior loader notes' },
    },
    degraded: false,
  };
}

function makeStrategy(): OptimisationStrategy {
  return {
    context_need: 'broad',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'error-focused',
    leanctx_mode: 'cognitive',
  };
}

let dir: string;
let metricsPath: string;
let memoryPath: string;
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-roundtrip-'));
  metricsPath = join(dir, 'metrics.db');
  memoryPath = join(dir, 'memory.db');
  memory = new MemoryStore(memoryPath);
});

afterEach(() => {
  try {
    memory.close();
  } catch {
    // best-effort
  }
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(): McpDeps {
  return {
    metricsPath,
    memory,
    steer: vi.fn(async () => makeSteering()),
    getStrategy: vi.fn(() => makeStrategy()),
    leanctx: {
      optimize: vi.fn(async (req: { target: string; taskType: string }) => ({
        context: 'compressed context',
        sourceSize: 100,
        returnedSize: 25,
        mode: 'entropy',
        estimatedTokensSaved: 19,
        taskType: req.taskType,
        degraded: false,
      })),
    },
    rtk: {
      optimize: vi.fn(async (req: { command: string }) => ({
        command: req.command,
        rawOutput: 'lots of noisy output',
        optimisedOutput: 'short',
        rawOutputSize: 400,
        optimisedOutputSize: 100,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 25,
        estimatedTokensSaved: 75,
        timestamp: new Date().toISOString(),
        degraded: false,
      })),
    },
    serena: {
      search: vi.fn(async (req: { query: string }) => ({
        query: req.query,
        symbols: [{ name: 'Foo', file: 'src/foo.ts', line: 1 }],
        files: ['src/foo.ts'],
        rawText: 'Foo  src/foo.ts:1',
        degraded: false,
      })),
    },
  };
}

async function statsLines(): Promise<{ exit: number; out: string }> {
  const lines: string[] = [];
  const exit = await runStats({ metricsPath, log: (l) => lines.push(l) });
  return { exit, out: lines.join('\n') };
}

describe('full round trip through the MCP services + stats', () => {
  it('calls every service and stats reports the tokens saved', async () => {
    const deps = makeDeps();

    // 1. steer — records 0 saved (steering only).
    const steer = await steerTool({ task: 'debug the loader' }, deps);
    expect(steer.steering).toMatchObject({ task: 'debug' });

    // 2. optimize_context (LeanCTX) — records 19 saved.
    const opt = await optimizeContextTool({ task: 'extract context', target: 'src/loader' }, deps);
    expect(opt.estimatedTokensSaved).toBe(19);

    // 3. find_relevant_symbols (Serena) — records 0 saved, resolves symbols.
    const symbols = await findRelevantSymbolsTool(
      { query: 'loader', cwd: process.cwd() },
      deps,
    );
    expect(Array.isArray(symbols.symbols)).toBe(true);
    expect((symbols.symbols as unknown[]).length).toBe(1);

    // 4. compress_command_output (RTK) — records 75 saved.
    const comp = await compressCommandOutputTool({ command: 'git status' }, deps);
    expect(comp.estimatedTokensSaved).toBe(75);

    // 5. chat_memory_store — records 0 saved.
    const mem = await chatMemoryStoreTool({ action: 'store', content: 'round-trip note' }, deps);
    expect(mem.action).toBe('store');

    // ---- verify stats ----
    const { exit, out } = await statsLines();
    expect(exit).toBe(0);

    // 5 events: steer, steer(optimize's internal), optimize_context,
    // find_relevant_symbols, compress_command_output, chat_memory_store.
    expect(out).toContain('Events:');
    // Total tokens saved = 19 + 75 = 94.
    expect(out).toContain('94');
    expect(out).toContain('Savings by tool:');
    expect(out).toContain('leanctx');
    expect(out).toContain('19 tokens');
    expect(out).toContain('rtk');
    expect(out).toContain('75 tokens');
  });

  it('round-trips through the handleToolCall MCP dispatch and stats sees savings', async () => {
    const deps = makeDeps();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['steering', { task: 'debug the loader' }],
      ['optimize_context', { task: 'extract', target: 'src/loader' }],
      ['find_relevant_symbols', { query: 'loader', cwd: process.cwd() }],
      ['compress_command_output', { command: 'git status' }],
      ['chat_memory_store', { action: 'store', content: 'via dispatch' }],
    ];

    for (const [name, args] of calls) {
      const result = await handleToolCall(name, args, deps);
      expect(result.isError, `expected ${name} to succeed`).toBeUndefined();
      expect(result.content[0]?.text).toBeTruthy();
    }

    const { exit, out } = await statsLines();
    expect(exit).toBe(0);
    expect(out).toContain('94');
    expect(out).toContain('Savings by tool:');
    expect(out).toContain('19 tokens');
    expect(out).toContain('75 tokens');
  });
});
