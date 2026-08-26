import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyTool,
  compressCommandOutputTool,
  findRelevantSymbolsTool,
  handleToolCall,
  optimizeContextTool,
  type McpDeps,
} from '../src/mcp';
import type { ClassificationOutcome } from '../src/classifier';
import type { OptimisationStrategy } from '../src/policy';
import { MetricsStore } from '../src/metrics';

function makeClassification(): ClassificationOutcome {
  return {
    classification: {
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
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
  const deps: McpDeps = {
    classify,
    getStrategy,
    leanctx: { optimize: leanctxOptimize },
    rtk: { optimize: rtkOptimize },
    serena: { search: serenaSearch },
    metricsPath,
    ...overrides,
  };
  return { deps, classify, getStrategy, leanctxOptimize, rtkOptimize, serenaSearch };
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
    expect(leanctxOptimize).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'src/foo.ts', mode: 'cognitive', taskType: 'debug' }),
    );
    expect(savingsByTool(metricsPath).leanctx).toBe(19);
    expect(callsByTool(metricsPath).ollama).toBe(1);
    expect(callsByTool(metricsPath).leanctx).toBe(1);
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
    expect(result.classification).toEqual(makeClassification().classification);
    expect(result.strategy).toEqual(makeStrategy());
    expect(result.degraded).toBe(false);
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

describe('handleToolCall', () => {
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
