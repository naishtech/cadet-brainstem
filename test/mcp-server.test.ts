import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_POLICY,
  assessContextTool,
  chatMemoryStoreTool,
  steerTool,
  handleToolCall,
  optimizeContextTool,
  type McpDeps,
} from '../src/mcp';
import {
  RESPONSE_POLICY_DIRECTIVES,
  type SteeringOutcome,
  type ContextAssessmentOutcome,
} from '../src/steering';
import type { OptimisationStrategy } from '../src/policy';
import { MetricsStore } from '../src/metrics';

import { MemoryStore } from '../src/memory';

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
      response_policy: {
        directives: ['compact', 'delta_only'],
        language_standard: 'microsoft',
      },
      guidance: 'Advisory: trace the loader debug path and verify before concluding.',
      reminders: [{ tool: 'rtk', message: 'Use RTK for git output' }],
      subtasks: ['coding_new'],
      evidence_plan: {
        prioritized_queries: [
          { id: 'q1', query: 'loader', sources: ['serena'], cost_estimate: 'cheap' },
        ],
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-mcp-'));
  metricsPath = join(dir, 'metrics.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<McpDeps> = {}) {
  const steer = vi.fn(async () => makeSteering());
  const getStrategy = vi.fn(() => makeStrategy());
  const leanctxOptimize = vi.fn(async (req: { target: string; taskType: string }) => ({
    context: 'compressed',
    sourceSize: 100,
    returnedSize: 25,
    mode: 'entropy',
    estimatedTokensSaved: 19,
    taskType: req.taskType,
    degraded: false,
  }));
  const rtkOptimize = vi.fn(async (req: { command: string }) => ({
    command: req.command,
    rawOutput: 'lots of output',
    optimisedOutput: 'short',
    rawOutputSize: 400,
    optimisedOutputSize: 100,
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 25,
    estimatedTokensSaved: 75,
    timestamp: new Date().toISOString(),
    degraded: false,
  }));
  const serenaSearch = vi.fn(async (req: { query: string }) => ({
    query: req.query,
    symbols: [{ name: 'Foo', file: 'src/foo.ts', line: 1 }],
    files: ['src/foo.ts'],
    rawText: 'Foo  src/foo.ts:1',
    degraded: false,
  }));
  const serenaForward = vi.fn(async (req: { tool: string }) => ({
    tool: req.tool,
    result: { content: [{ type: 'text', text: 'references:\n  Foo: src/a.h:3' }] },
    rawText: 'references:\n  Foo: src/a.h:3',
    degraded: false,
  }));
  const serenaList = vi.fn(async () => ({
    tools: [{ name: 'find_symbol' }, { name: 'rename_symbol' }],
    degraded: false,
  }));
  const leanctxForward = vi.fn(async (req: { tool: string }) => ({
    tool: req.tool,
    result: {
      content: [{ type: 'text', text: 'ctx_shell -> compressed shell output' }],
    },
    rawText: 'ctx_shell -> compressed shell output',
    degraded: false,
  }));
  const leanctxList = vi.fn(async () => ({
    tools: [{ name: 'ctx_read' }, { name: 'ctx_shell' }, { name: 'ctx_gain' }],
    degraded: false,
  }));
  const deps: McpDeps = {
    steer,
    getStrategy,
    leanctx: { optimize: leanctxOptimize },
    serena: { search: serenaSearch, callTool: serenaForward, listTools: serenaList },
    metricsPath,
    ...overrides,
  };
  return {
    deps,
    steer,
    getStrategy,
    leanctxOptimize,
    rtkOptimize,
    serenaSearch,
    serenaForward,
    serenaList,
    leanctxForward,
    leanctxList,
  };
}

function savingsByTool(path: string): Record<string, number> {
  const store = new MetricsStore(path);
  const rows = store.getSavingsByTool();
  store.close();
  return Object.fromEntries(rows.map((r) => [r.key, r.estimatedTokensSaved]));
}

function callsByTool(path: string): Record<string, number> {
  const store = new MetricsStore(path);
  const rows = store.getCallsByTool();
  store.close();
  return Object.fromEntries(rows.map((r) => [r.tool, r.calls]));
}

function callStatsByTool(
  path: string,
): Record<string, { calls: number; degraded: number; avgLatencyMs: number | null }> {
  const store = new MetricsStore(path);
  const rows = store.getCallStatsByTool();
  store.close();
  return Object.fromEntries(
    rows.map((r) => [
      r.tool,
      { calls: r.calls, degraded: r.degraded, avgLatencyMs: r.avgLatencyMs },
    ]),
  );
}

function rowsForTool(path: string, tool: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path);
  const rows = db
    .prepare('SELECT * FROM optimisation_events WHERE tool = ?')
    .all(tool) as Record<string, unknown>[];
  db.close();
  return rows;
}

function firstRowForTool(path: string, tool: string): Record<string, unknown> {
  const row = rowsForTool(path, tool)[0];
  if (row === undefined) {
    throw new Error(`no ${tool} row recorded`);
  }
  return row;
}

describe('optimize_context', () => {
  it('classifies, compiles via LeanCTX with the policy mode, and records metrics', async () => {
    const { deps, leanctxOptimize } = makeDeps();

    const result = await optimizeContextTool(
      { task: 'debug the loader', target: 'src/foo.ts' },
      deps,
    );

    expect(result.context).toBe('compressed');
    expect(result.mode).toBe('entropy');
    expect(result.degraded).toBe(false);
    expect(result.response_policy).toEqual({
      directives: {
        preserve_evidence: RESPONSE_POLICY_DIRECTIVES.preserve_evidence,
        progressive_disclosure: RESPONSE_POLICY_DIRECTIVES.progressive_disclosure,
        follow_tool_plan: RESPONSE_POLICY_DIRECTIVES.follow_tool_plan,
      },
      language_standard: 'microsoft',
    });
    expect(result.tool_plan).toEqual({
      recommended_tools: [
        { name: 'find_relevant_symbols', intent: 'locate the code/symbols involved in the issue', priority: 1 },
      ],
    });
    expect(result.guidance).toBeUndefined();
    expect(result.evidence_plan).toBeUndefined();
    expect(result.memory_hints).toEqual({
      use: 'if_necessary',
      reason: 'check prior loader notes',
    });
    expect(result.reminders).toEqual([
      { tool: 'find_relevant_symbols', message: 'locate the code/symbols involved in the issue; use find_relevant_symbols.' },
    ]);
    expect(result.subtasks).toEqual(['coding_new']);
    expect(result.memory_policy).toBe(
      'Check memory if it helps: consult `chat_memory_store` when it may reduce work, but verify retrieved facts before acting.',
    );
    expect(leanctxOptimize).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'src/foo.ts', mode: 'cognitive', taskType: 'debug' }),
    );
    expect(savingsByTool(metricsPath).leanctx).toBe(19);
    expect(callsByTool(metricsPath).ollama).toBe(1);
    expect(callsByTool(metricsPath).leanctx).toBe(1);

    // steer -> optimize_context share a request_id, with latency + degraded.
    const ollamaRow = firstRowForTool(metricsPath, 'ollama');
    const leanctxRow = firstRowForTool(metricsPath, 'leanctx');
    expect(ollamaRow.request_id).toBeTruthy();
    expect(leanctxRow.request_id).toBe(ollamaRow.request_id);
    expect(ollamaRow.degraded).toBe(0);
    expect(typeof ollamaRow.latency_ms).toBe('number');
  });

  it('returns a note when optimize_context finds no compression benefit', async () => {
    const { deps, leanctxOptimize } = makeDeps();
    leanctxOptimize.mockResolvedValueOnce({
      context: 'short file content',
      sourceSize: 20,
      returnedSize: 20,
      mode: 'reference',
      estimatedTokensSaved: 0,
      taskType: 'debug',
      degraded: false,
    });

    const result = await optimizeContextTool(
      { task: 'debug the loader', target: 'src/foo.ts' },
      deps,
    );

    expect(result.estimatedTokensSaved).toBe(0);
    expect(result.note).toBe('no compression benefit from LeanCTX on this target');
  });

  it('does not record an ollama call when steering degrades', async () => {
    const { deps } = makeDeps();
    const degradedDeps = {
      ...deps,
      steer: vi.fn(async () => ({
        steering: makeSteering().steering,
        degraded: true,
        reason: 'ollama unreachable',
      })),
    };

    await optimizeContextTool(
      { task: 'debug the loader', target: 'src/foo.ts' },
      degradedDeps,
    );

    expect(callsByTool(metricsPath).ollama).toBeUndefined();
    expect(callsByTool(metricsPath).leanctx).toBe(1);

    // The degraded outcome IS recorded (marked degraded) — just not counted as a real call.
    expect(callStatsByTool(metricsPath).ollama?.degraded).toBe(1);
    expect(callStatsByTool(metricsPath).ollama?.calls).toBe(0);
  });

  it('rejects empty task/target', async () => {
    const { deps } = makeDeps();
    await expect(
      optimizeContextTool({ task: '', target: 'x' }, deps),
    ).rejects.toThrow('non-empty string "task"');
    await expect(
      optimizeContextTool({ task: 't', target: '' }, deps),
    ).rejects.toThrow('non-empty string "target"');
  });
});

describe('steering', () => {
  it('classifies, returns the strategy, and records an ollama call', async () => {
    const { deps } = makeDeps();
    const result = await steerTool({ task: 'debug the loader' }, deps);
    expect(result.steering).toEqual({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
    });
    expect(result.strategy).toEqual({
      compression: 'normal',
      code_search: 'semantic',
      terminal_output: 'error-focused',
      leanctx_mode: 'cognitive',
    });
    expect(result.degraded).toBe(false);
    expect(result.response_policy).toEqual({
      directives: {
        preserve_evidence: RESPONSE_POLICY_DIRECTIVES.preserve_evidence,
        progressive_disclosure: RESPONSE_POLICY_DIRECTIVES.progressive_disclosure,
        follow_tool_plan: RESPONSE_POLICY_DIRECTIVES.follow_tool_plan,
      },
      language_standard: 'microsoft',
    });
    expect(result.tool_plan).toEqual({
      recommended_tools: [
        { name: 'find_relevant_symbols', intent: 'locate the code/symbols involved in the issue', priority: 1 },
      ],
    });
    expect(result.guidance).toBeUndefined();
    expect(result.evidence_plan).toBeUndefined();
    expect(result.memory_hints).toEqual({
      use: 'if_necessary',
      reason: 'check prior loader notes',
    });
    expect(result.reminders).toEqual([
      { tool: 'find_relevant_symbols', message: 'locate the code/symbols involved in the issue; use find_relevant_symbols.' },
    ]);
    expect(result.subtasks).toEqual(['coding_new']);
    expect(result.memory_policy).toBe(
      'Check memory if it helps: consult `chat_memory_store` when it may reduce work, but verify retrieved facts before acting.',
    );
    expect(callsByTool(metricsPath).ollama).toBe(1);
  });

  it('does not record an ollama call when steering degrades', async () => {
    const { deps } = makeDeps();
    const degradedDeps = {
      ...deps,
      steer: vi.fn(async () => ({
        steering: makeSteering().steering,
        degraded: true,
        reason: 'ollama unreachable',
      })),
    };
    const result = await steerTool(
      { task: 'debug the loader' },
      degradedDeps,
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('ollama unreachable');
    expect(callsByTool(metricsPath).ollama).toBeUndefined();
    expect(callStatsByTool(metricsPath).ollama?.degraded).toBe(1);
    expect(callStatsByTool(metricsPath).ollama?.calls).toBe(0);
  });

  it('returns and stamps a caller-supplied request_id', async () => {
    const { deps } = makeDeps();
    const result = await steerTool(
      { task: 'debug the loader', request_id: 'rid-42' },
      deps,
    );
    expect(result.request_id).toBe('rid-42');
    expect(firstRowForTool(metricsPath, 'ollama').request_id).toBe('rid-42');
  });

  it('generates a request_id when none is supplied', async () => {
    const { deps } = makeDeps();
    const result = await steerTool({ task: 'debug the loader' }, deps);
    const requestId = result.request_id as string;
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
  });

  it('rejects an empty task', async () => {
    const { deps } = makeDeps();
    await expect(steerTool({ task: '' }, deps)).rejects.toThrow('task');
  });
});

/* Legacy LeanCTX proxy tests were removed with the public proxy surface. */
/*
describe.skip('leanctx_call', () => {
  it('forwards any ctx_* tool and records a leanctx event', async () => {
    const { deps, leanctxForward } = makeDeps();

    const result = await leanctxCallTool(
      {
        tool: 'ctx_shell',
        arguments: { command: 'git status', raw: true },
        cwd: 'E:/proj',
      },
      deps,
    );

    expect(result.degraded).toBe(false);
    expect(result.tool).toBe('ctx_shell');
    expect(leanctxForward).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'ctx_shell',
        arguments: { command: 'git status', raw: true },
        cwd: 'E:/proj',
      }),
    );
    expect(callsByTool(metricsPath).leanctx).toBe(1);
    const row = firstRowForTool(metricsPath, 'leanctx');
    expect(row.operation).toBe('ctx_shell');
    expect(row.request_id).toBeTruthy();
  });

  it('rejects an empty tool', async () => {
    const { deps } = makeDeps();
    await expect(leanctxCallTool({ tool: '' }, deps)).rejects.toThrow('tool');
  });

  it('degrades gracefully when the passthrough is unavailable', async () => {
    const { deps } = makeDeps({ leanctx: {} });
    const result = await leanctxCallTool({ tool: 'ctx_read' }, deps);
    expect(result.degraded).toBe(true);
  });
});

describe.skip('leanctx_list_tools', () => {
  it('lists the tools LeanCTX currently exposes and records an event', async () => {
    const { deps, leanctxList } = makeDeps();

    const result = await leanctxListToolsTool({ cwd: 'E:/proj' }, deps);

    expect(result.tools).toEqual(['ctx_read', 'ctx_shell', 'ctx_gain']);
    expect(result.degraded).toBe(false);
    expect(leanctxList).toHaveBeenCalled();
    expect(callsByTool(metricsPath).leanctx).toBe(1);
    expect(firstRowForTool(metricsPath, 'leanctx').operation).toBe('list_tools');
  });

  it('degrades gracefully when the passthrough is unavailable', async () => {
    const { deps } = makeDeps({ leanctx: {} });
    const result = await leanctxListToolsTool({ cwd: 'E:/proj' }, deps);
    expect(result.tools).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});

describe.skip('compress_command_output', () => {
  it('returns the reduced output (not the raw text) and records rtk savings', async () => {
    const { deps, rtkOptimize } = makeDeps();

    const result = await compressCommandOutputTool(
      { command: 'git status' },
      deps,
    );

    expect(result.optimisedOutput).toBe('short');
    expect(result.rawOutputSize).toBe(400);
    expect(result.estimatedTokensSaved).toBe(75);
    expect(JSON.stringify(result)).not.toContain('lots of output');
    expect(rtkOptimize).toHaveBeenCalledWith({ command: 'git status' });
    expect(savingsByTool(metricsPath).rtk).toBe(75);
    const rtkRow = firstRowForTool(metricsPath, 'rtk');
    expect(rtkRow.request_id).toBeTruthy();
    expect(rtkRow.degraded).toBe(0);
    expect(typeof rtkRow.latency_ms).toBe('number');
  });

  it('rejects an empty command', async () => {
    const { deps } = makeDeps();
    await expect(
      compressCommandOutputTool({ command: '   ' }, deps),
    ).rejects.toThrow('non-empty string "command"');
  });

  it('forwards a shell and notes when nothing is compressed', async () => {
    const { deps, rtkOptimize } = makeDeps();
    rtkOptimize.mockImplementation(async (req: { command: string }) => ({
      command: req.command,
      rawOutput: 'raw',
      optimisedOutput: 'raw',
      rawOutputSize: 100,
      optimisedOutputSize: 100,
      estimatedTokensBefore: 25,
      estimatedTokensAfter: 25,
      estimatedTokensSaved: 0,
      timestamp: new Date().toISOString(),
      degraded: false,
    }));

    const result = await compressCommandOutputTool(
      { command: 'grep -r foo', shell: 'bash' },
      deps,
    );

    expect(rtkOptimize).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'grep -r foo', shell: 'bash' }),
    );
    expect(result.note).toContain('nothing to compress');
  });
});
*/

describe('chat_memory_store', () => {
  it('round-trips store -> search -> get -> update -> delete and records a memory event', async () => {
    const store = new MemoryStore(':memory:');
    const { deps } = makeDeps({ memory: store });

    const stored = await chatMemoryStoreTool(
      {
        action: 'store',
        content: 'node:sqlite crashes under non-TTY git-bash',
        tags: ['gotcha'],
        project: 'cadet-brainstem',
      },
      deps,
    );
    expect(stored.memory_policy).toBe(MEMORY_POLICY);
    const id = (stored.result as { id: string }).id;
    expect(id).toBeTruthy();

    const searched = await chatMemoryStoreTool(
      { action: 'search', query: 'sqlite', tags: ['gotcha'] },
      deps,
    );
    expect(searched.result as Array<Record<string, unknown>>).toHaveLength(1);

    const got = await chatMemoryStoreTool({ action: 'get', id }, deps);
    expect((got.result as { hits: number }).hits).toBe(1);

    const updated = await chatMemoryStoreTool(
      { action: 'update', id, content: 'updated' },
      deps,
    );
    expect((updated.result as { updated: boolean }).updated).toBe(true);

    const deleted = await chatMemoryStoreTool({ action: 'delete', id }, deps);
    expect((deleted.result as { deleted: boolean }).deleted).toBe(true);

    expect(callsByTool(metricsPath).memory).toBe(5);
    expect(firstRowForTool(metricsPath, 'memory').operation).toBe('store');
    expect(firstRowForTool(metricsPath, 'memory').request_id).toBeTruthy();
    store.close();
  });

  it('degrades gracefully when the memory store is unavailable', async () => {
    const store = new MemoryStore(':memory:');
    store.close();
    const { deps } = makeDeps({ memory: store });
    const result = await chatMemoryStoreTool(
      { action: 'store', content: 'x' },
      deps,
    );
    expect(result.degraded).toBe(true);
    expect(result.error).toBeTruthy();
    expect(callStatsByTool(metricsPath).memory?.degraded).toBe(1);
  });

  it('rejects an invalid action', async () => {
    const { deps } = makeDeps();
    await expect(
      chatMemoryStoreTool({ action: 'nope' }, deps),
    ).rejects.toThrow('valid "action"');
  });

  it('rejects missing content for store', async () => {
    const { deps } = makeDeps();
    await expect(
      chatMemoryStoreTool({ action: 'store' }, deps),
    ).rejects.toThrow('content');
  });
});

describe('assess_context', () => {
  it('rebuilds the inventory and returns the controller verdict', async () => {
    const { deps } = makeDeps({
      assess: vi.fn(async (): Promise<ContextAssessmentOutcome> => ({
        assessment: {
            verdict: 'continue',
            tool_plan: {
              recommended_tools: [
                { name: 'find_relevant_symbols', intent: 'semantic search', priority: 1 },
              ],
            },
            reason: 'need the symbol definitions',
          },
        degraded: false,
      })),
    });
    const store = new MetricsStore(metricsPath);
    store.record({
      timestamp: new Date().toISOString(),
      session_id: 'mcp',
      task_type: 'debug',
      complexity: 'medium',
      risk: 'medium',
      tool: 'serena',
      operation: 'find_relevant_symbols',
      estimated_input_tokens: 100,
      estimated_output_tokens: 50,
      estimated_tokens_saved: 0,
      compression_ratio: 1,
      optimisation_strategy: null,
      symbols_found: 3,
      files_found: 1,
      degraded: false,
      request_id: 'rid-7',
    });
    store.close();

    const result = await assessContextTool(
      { request_id: 'rid-7', task: 'fix the loader' },
      deps,
    );

    expect(result.verdict).toBe('continue');
    expect(result.tool_plan).toEqual({
      recommended_tools: [
        { name: 'find_relevant_symbols', intent: 'semantic search', priority: 1 },
      ],
    });
    expect(result.reason).toBe('need the symbol definitions');
    expect(result.degraded).toBe(false);
    expect(result.inventory).toHaveLength(1);
    const row = firstRowForTool(metricsPath, 'ollama');
    expect(row.operation).toBe('assess_context');
    expect(row.request_id).toBe('rid-7');
  });

  it('degrades to stop when the controller is unavailable', async () => {
    const { deps } = makeDeps({
      assess: vi.fn(async (): Promise<ContextAssessmentOutcome> => ({
        assessment: {
          verdict: 'stop',
          tool_plan: {},
          reason: 'controller unavailable — no loop',
        },
        degraded: true,
        reason: 'ollama down',
      })),
    });
    const result = await assessContextTool({ request_id: 'rid-9' }, deps);
    expect(result.verdict).toBe('stop');
    expect(result.degraded).toBe(true);
  });

  it('rejects an empty request_id', async () => {
    const { deps } = makeDeps();
    await expect(
      assessContextTool({ request_id: '' }, deps),
    ).rejects.toThrow('non-empty string "request_id"');
  });
});

describe('handleToolCall', () => {
  it('dispatches chat_memory_store and returns JSON text', async () => {
    const store = new MemoryStore(':memory:');
    const { deps } = makeDeps({ memory: store });
    const res = await handleToolCall(
      'chat_memory_store',
      { action: 'store', content: 'hi' },
      deps,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"memory_policy"');
    store.close();
  });

  it('returns JSON text for a valid call', async () => {
    const { deps } = makeDeps();
    const res = await handleToolCall(
      'optimize_context',
      { task: 'inspect Foo', target: 'E:/proj/src/foo.ts' },
      deps,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"context": "compressed"');
  });

  it('returns isError for invalid arguments', async () => {
    const { deps } = makeDeps();
    const res = await handleToolCall(
      'optimize_context',
      { task: '', target: 'x' },
      deps,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('non-empty string "task"');
  });

  it('dispatches steer and returns JSON text with the strategy', async () => {
    const { deps } = makeDeps();
    const res = await handleToolCall('steering', { task: 'x' }, deps);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"steering"');
    expect(res.content[0]?.text).toContain('"strategy"');
    expect(callsByTool(metricsPath).ollama).toBe(1);
  });

  it('dispatches the temporary `classify` alias to steering', async () => {
    const { deps } = makeDeps();
    const res = await handleToolCall('classify', { task: 'x' }, deps);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"steering"');
    expect(res.content[0]?.text).toContain('"strategy"');
  });

  it('returns isError for an unknown tool', async () => {
    const res = await handleToolCall('nope', {}, makeDeps().deps);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('Unknown tool: nope');
  });

  it('still returns the result when metrics recording fails', async () => {
    const { deps } = makeDeps();
    const bad = { ...deps, metricsPath: join(dir, 'no-such-dir', 'm.db') };
    const res = await handleToolCall(
      'optimize_context',
      { task: 'debug the loader', target: 'src/foo.ts' },
      bad,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('compressed');
  });
});
