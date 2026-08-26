import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MetricsStore,
  getDefaultMetricsPath,
  type OptimisationEvent,
} from '../src/metrics/index';

function makeEvent(overrides: Partial<OptimisationEvent> = {}): OptimisationEvent {
  return {
    timestamp: '2026-08-25T10:00:00.000Z',
    session_id: 'sess-1',
    task_type: 'debug',
    complexity: 'medium',
    risk: 'medium',
    tool: 'leanctx',
    operation: 'compress',
    estimated_input_tokens: 1000,
    estimated_output_tokens: 200,
    estimated_tokens_saved: 800,
    compression_ratio: 0.8,
    optimisation_strategy: 'normal',
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-metrics-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Guard against a leaked override from the environment (e.g. a prior
  // `CADET_TOKEN_SAVER_METRICS=... cadet-token-saver init` in the same shell).
  delete process.env.CADET_TOKEN_SAVER_METRICS;
});

afterEach(() => {
  delete process.env.CADET_TOKEN_SAVER_METRICS;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getDefaultMetricsPath', () => {
  it('returns a stable default path', () => {
    expect(getDefaultMetricsPath()).toMatch(/\.cadet-token-saver[/\\]metrics\.db$/);
  });

  it('honours the CADET_TOKEN_SAVER_METRICS override', () => {
    process.env.CADET_TOKEN_SAVER_METRICS = 'C:/custom/metrics.db';
    expect(getDefaultMetricsPath()).toBe('C:/custom/metrics.db');
  });
});

describe('MetricsStore (in-memory)', () => {
  let store: MetricsStore;

  beforeEach(() => {
    store = new MetricsStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('starts empty', () => {
    expect(store.count()).toBe(0);
    expect(store.getTotals()).toEqual({
      eventCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTokensSaved: 0,
    });
    expect(store.getSavingsByTool()).toEqual([]);
    expect(store.getSavingsByTaskType()).toEqual([]);
    expect(store.getAverageCompressionRatio()).toBeNull();
    expect(store.getMostExpensiveOperations()).toEqual([]);
    expect(store.getCallsByTool()).toEqual([]);
  });

  it('records events and totals them', () => {
    store.record(makeEvent({ estimated_input_tokens: 1000, estimated_tokens_saved: 800 }));
    store.record(makeEvent({ estimated_input_tokens: 2000, estimated_tokens_saved: 1200 }));
    expect(store.count()).toBe(2);
    expect(store.getTotals()).toEqual({
      eventCount: 2,
      estimatedInputTokens: 3000,
      estimatedOutputTokens: 400,
      estimatedTokensSaved: 2000,
    });
  });

  it('groups savings by tool', () => {
    store.record(makeEvent({ tool: 'rtk', estimated_tokens_saved: 100 }));
    store.record(makeEvent({ tool: 'leanctx', estimated_tokens_saved: 300 }));
    store.record(makeEvent({ tool: 'rtk', estimated_tokens_saved: 50 }));
    expect(store.getSavingsByTool()).toEqual([
      { key: 'leanctx', estimatedTokensSaved: 300 },
      { key: 'rtk', estimatedTokensSaved: 150 },
    ]);
  });

  it('counts calls by tool', () => {
    store.record(makeEvent({ tool: 'rtk' }));
    store.record(makeEvent({ tool: 'rtk' }));
    store.record(makeEvent({ tool: 'ollama' }));
    expect(store.getCallsByTool()).toEqual([
      { tool: 'ollama', calls: 1 },
      { tool: 'rtk', calls: 2 },
    ]);
  });

  it('excludes degraded events from call counts', () => {
    store.record(makeEvent({ tool: 'ollama', degraded: true }));
    store.record(makeEvent({ tool: 'ollama', degraded: false }));
    expect(store.getCallsByTool()).toEqual([{ tool: 'ollama', calls: 1 }]);
  });

  it('reports real calls, degraded, and average latency per tool', () => {
    store.record(makeEvent({ tool: 'rtk', degraded: false, latency_ms: 100 }));
    store.record(makeEvent({ tool: 'rtk', degraded: false, latency_ms: 300 }));
    store.record(makeEvent({ tool: 'rtk', degraded: true, latency_ms: 5000 }));
    store.record(makeEvent({ tool: 'serena', degraded: false }));
    expect(store.getCallStatsByTool()).toEqual([
      { tool: 'rtk', calls: 2, degraded: 1, avgLatencyMs: 200 },
      { tool: 'serena', calls: 1, degraded: 0, avgLatencyMs: null },
    ]);
  });

  it('groups savings by task type', () => {
    store.record(makeEvent({ task_type: 'debug', estimated_tokens_saved: 100 }));
    store.record(makeEvent({ task_type: 'refactor', estimated_tokens_saved: 250 }));
    expect(store.getSavingsByTaskType()).toEqual([
      { key: 'refactor', estimatedTokensSaved: 250 },
      { key: 'debug', estimatedTokensSaved: 100 },
    ]);
  });

  it('computes the average compression ratio, ignoring nulls', () => {
    store.record(makeEvent({ compression_ratio: 0.5 }));
    store.record(makeEvent({ compression_ratio: 0.9 }));
    store.record(makeEvent({ compression_ratio: null }));
    expect(store.getAverageCompressionRatio()).toBeCloseTo(0.7);
  });

  it('returns the most expensive operations by input tokens', () => {
    store.record(makeEvent({ tool: 'rtk', operation: 'tiny', estimated_input_tokens: 100 }));
    store.record(makeEvent({ tool: 'leanctx', operation: 'big', estimated_input_tokens: 9000 }));
    store.record(makeEvent({ tool: 'serena', operation: 'medium', estimated_input_tokens: 5000 }));
    const top = store.getMostExpensiveOperations(2);
    expect(top).toHaveLength(2);
    expect(top[0]?.operation).toBe('big');
    expect(top[1]?.operation).toBe('medium');
    expect(top[0]?.tool).toBe('leanctx');
  });

  it('persists to a file across reopen', () => {
    const dir = makeTempDir();
    const file = join(dir, 'metrics.db');

    const first = new MetricsStore(file);
    first.record(makeEvent());
    first.close();

    const second = new MetricsStore(file);
    expect(second.count()).toBe(1);
    expect(second.getTotals().estimatedTokensSaved).toBe(800);
    second.close();
  });

  it('migrates a pre-existing DB in place by adding the new columns', () => {
    const dir = makeTempDir();
    const file = join(dir, 'metrics.db');

    // Simulate a DB created before the degraded/latency/counts/linkage columns.
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE optimisation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      complexity TEXT NOT NULL,
      risk TEXT NOT NULL,
      tool TEXT NOT NULL,
      operation TEXT NOT NULL,
      estimated_input_tokens INTEGER NOT NULL,
      estimated_output_tokens INTEGER NOT NULL,
      estimated_tokens_saved INTEGER NOT NULL,
      compression_ratio REAL,
      optimisation_strategy TEXT
    );`);
    raw.close();

    const store = new MetricsStore(file);
    store.record(
      makeEvent({
        degraded: true,
        latency_ms: 42,
        request_id: 'req-1',
        symbols_found: 3,
        files_found: 2,
      }),
    );
    store.close();

    const readDb = new DatabaseSync(file);
    const rows = readDb
      .prepare('SELECT * FROM optimisation_events')
      .all() as Record<string, unknown>[];
    readDb.close();
    expect(rows[0]).toMatchObject({
      degraded: 1,
      latency_ms: 42,
      request_id: 'req-1',
      symbols_found: 3,
      files_found: 2,
    });
  });
});
