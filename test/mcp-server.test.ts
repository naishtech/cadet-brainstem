import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_POLICY,
  MEMORY_POLICY_SKIP,
  assessContextTool,
  chatMemoryStoreTool,
  classifyTool,
  compressCommandOutputTool,
  findRelevantSymbolsTool,
  handleToolCall,
  optimizeContextTool,
  serenaCallTool,
  serenaListToolsTool,
  type McpDeps,
} from '../src/mcp';
import {
  RESPONSE_POLICY_DIRECTIVES,
  type ClassificationOutcome,
  type ContextAssessmentOutcome,
} from '../src/classifier';
import type { OptimisationStrategy } from '../src/policy';
import { MetricsStore } from '../src/metrics';
import { MemoryStore } from '../src/memory';

function makeClassification(): ClassificationOutcome {
  return {
    classification: {
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      tool_plan: { use: ['optimize_context'], skip: ['compress_command_output'] },
      response_policy: ['compact', 'delta_only'],
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
  const classify = vi.fn(async () => makeClassification());
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
  const deps: McpDeps = {
    classify,
    getStrategy,
    leanctx: { optimize: leanctxOptimize },
    rtk: { optimize: rtkOptimize },
    serena: { search: serenaSearch, callTool: serenaForward, listTools: serenaList },
    metricsPath,
    ...overrides,
  };
  return {
    deps,
    classify,
    getStrategy,
    leanctxOptimize,
    rtkOptimize,
    serenaSearch,
    serenaForward,
    serenaList,
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
      compact: RESPONSE_POLICY_DIRECTIVES.compact,
      delta_only: RESPONSE_POLICY_DIRECTIVES.delta_only,
    });
    expect(result.tool_plan).toEqual({
      use: ['optimize_context'],
      skip: ['compress_command_output'],
    });
    expect(result.memory_policy).toBe(MEMORY_POLICY_SKIP);
    expect(leanctxOptimize).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'src/foo.ts', mode: 'cognitive', taskType: 'debug' }),
    );
    expect(savingsByTool(metricsPath).leanctx).toBe(19);
    expect(callsByTool(metricsPath).ollama).toBe(1);
    expect(callsByTool(metricsPath).leanctx).toBe(1);

    // classify -> optimize_context share a request_id, with latency + degraded.
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

  it('does not record an ollama call when classification degrades', async () => {
    const { deps } = makeDeps();
    const degradedDeps = {
      ...deps,
      classify: vi.fn(async () => ({
        classification: makeClassification().classification,
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

describe('classify', () => {
  it('classifies, returns the strategy, and records an ollama call', async () => {
    const { deps } = makeDeps();
    const result = await classifyTool({ task: 'debug the loader' }, deps);
    expect(result.classification).toEqual({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
    });
    expect(result.strategy).toEqual(makeStrategy());
    expect(result.degraded).toBe(false);
    expect(result.response_policy).toEqual({
      compact: RESPONSE_POLICY_DIRECTIVES.compact,
      delta_only: RESPONSE_POLICY_DIRECTIVES.delta_only,
    });
    expect(result.tool_plan).toEqual({
      use: ['optimize_context'],
      skip: ['compress_command_output'],
    });
    expect(result.memory_policy).toBe(MEMORY_POLICY_SKIP);
    expect(callsByTool(metricsPath).ollama).toBe(1);
  });

  it('does not record an ollama call when classification degrades', async () => {
    const { deps } = makeDeps();
    const degradedDeps = {
      ...deps,
      classify: vi.fn(async () => ({
        classification: makeClassification().classification,
        degraded: true,
        reason: 'ollama unreachable',
      })),
    };
    const result = await classifyTool(
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
    const result = await classifyTool(
      { task: 'debug the loader', request_id: 'rid-42' },
      deps,
    );
    expect(result.request_id).toBe('rid-42');
    expect(firstRowForTool(metricsPath, 'ollama').request_id).toBe('rid-42');
  });

  it('generates a request_id when none is supplied', async () => {
    const { deps } = makeDeps();
    const result = await classifyTool({ task: 'debug the loader' }, deps);
    const requestId = result.request_id as string;
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
  });

  it('rejects an empty task', async () => {
    const { deps } = makeDeps();
    await expect(classifyTool({ task: '' }, deps)).rejects.toThrow('task');
  });
});

describe('find_relevant_symbols', () => {
  it('returns symbols/files and records a serena event', async () => {
    const { deps, serenaSearch } = makeDeps();

    const result = await findRelevantSymbolsTool(
      { query: 'Foo', cwd: 'E:/proj' },
      deps,
    );

    expect(result.files).toEqual(['src/foo.ts']);
    expect(result.degraded).toBe(false);
    expect(serenaSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Foo', cwd: 'E:/proj' }),
    );
    expect(savingsByTool(metricsPath).serena).toBe(0);
    expect(callStatsByTool(metricsPath).serena?.calls).toBe(1);
    const serenaRow = firstRowForTool(metricsPath, 'serena');
    expect(serenaRow.symbols_found).toBe(1);
    expect(serenaRow.files_found).toBe(1);
    expect(serenaRow.request_id).toBeTruthy();
    expect(serenaRow.degraded).toBe(0);
  });

  it('rejects missing query/cwd', async () => {
    const { deps } = makeDeps();
    await expect(
      findRelevantSymbolsTool({ query: '', cwd: 'E:/proj' }, deps),
    ).rejects.toThrow('non-empty string "query"');
    await expect(
      findRelevantSymbolsTool({ query: 'Foo', cwd: '' }, deps),
    ).rejects.toThrow('non-empty string "cwd"');
  });
});

describe('serena_call', () => {
  it('forwards any Serena tool and records a serena event', async () => {
    const { deps, serenaForward } = makeDeps();

    const result = await serenaCallTool(
      {
        tool: 'find_referencing_symbols',
        arguments: { name_path_pattern: 'Foo' },
        cwd: 'E:/proj',
      },
      deps,
    );

    expect(result.degraded).toBe(false);
    expect(result.tool).toBe('find_referencing_symbols');
    expect(serenaForward).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'find_referencing_symbols',
        arguments: { name_path_pattern: 'Foo' },
        cwd: 'E:/proj',
      }),
    );
    expect(callsByTool(metricsPath).serena).toBe(1);
    const row = firstRowForTool(metricsPath, 'serena');
    expect(row.operation).toBe('find_referencing_symbols');
    expect(row.request_id).toBeTruthy();
  });

  it('rejects an empty tool', async () => {
    const { deps } = makeDeps();
    await expect(serenaCallTool({ tool: '' }, deps)).rejects.toThrow('tool');
  });

  it('degrades gracefully when the passthrough is unavailable', async () => {
    const { deps } = makeDeps({ serena: {} });
    const result = await serenaCallTool({ tool: 'find_symbol' }, deps);
    expect(result.degraded).toBe(true);
  });
});

describe('serena_list_tools', () => {
  it('lists the tools Serena currently exposes and records an event', async () => {
    const { deps, serenaList } = makeDeps();

    const result = await serenaListToolsTool({ cwd: 'E:/proj' }, deps);

    expect(result.tools).toEqual(['find_symbol', 'rename_symbol']);
    expect(result.degraded).toBe(false);
    expect(serenaList).toHaveBeenCalled();
    expect(callsByTool(metricsPath).serena).toBe(1);
    expect(firstRowForTool(metricsPath, 'serena').operation).toBe('list_tools');
  });

  it('degrades gracefully when the passthrough is unavailable', async () => {
    const { deps } = makeDeps({ serena: {} });
    const result = await serenaListToolsTool({ cwd: 'E:/proj' }, deps);
    expect(result.tools).toEqual([]);
    expect(result.degraded).toBe(true);
  });
});

describe('compress_command_output', () => {
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

describe('chat_memory_store', () => {
  it('round-trips store -> search -> get -> update -> delete and records a memory event', async () => {
    const store = new MemoryStore(':memory:');
    const { deps } = makeDeps({ memory: store });

    const stored = await chatMemoryStoreTool(
      {
        action: 'store',
        content: 'node:sqlite crashes under non-TTY git-bash',
        tags: ['gotcha'],
        project: 'cadet-token-saver',
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
          tool_plan: { use: ['find_relevant_symbols'], skip: [] },
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
      use: ['find_relevant_symbols'],
      skip: [],
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
          tool_plan: { use: [], skip: [] },
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
      'find_relevant_symbols',
      { query: 'Foo', cwd: 'E:/proj' },
      deps,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('src/foo.ts');
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

  it('dispatches classify and returns JSON text with the strategy', async () => {
    const { deps } = makeDeps();
    const res = await handleToolCall('classify', { task: 'x' }, deps);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"classification"');
    expect(res.content[0]?.text).toContain('"strategy"');
    expect(callsByTool(metricsPath).ollama).toBe(1);
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
      'compress_command_output',
      { command: 'git status' },
      bad,
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('short');
  });
});
