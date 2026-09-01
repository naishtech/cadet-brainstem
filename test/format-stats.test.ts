import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatStats, MetricsStore } from '../src/metrics';

const tempDirs: string[] = [];

function tempMetrics(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fmt-'));
  tempDirs.push(dir);
  return join(dir, 'metrics.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('formatStats', () => {
  it('returns an empty, estimated payload for an empty store', () => {
    const store = new MetricsStore(tempMetrics());
    try {
      const payload = formatStats(store);
      expect(payload.estimated).toBe(true);
      expect(payload.count).toBe(0);
      expect(payload.totals.eventCount).toBe(0);
      expect(payload.totals.inputTokens).toBe(0);
      expect(payload.totals.reductionPct).toBe(0);
      expect(payload.totals.avgCompressionRatio).toBeNull();
      expect(payload.savingsByTool).toEqual([]);
      expect(payload.savingsByTaskType).toEqual([]);
      expect(payload.callStats).toEqual([]);
      expect(payload.sessions).toEqual([]);
      expect(payload.mostExpensiveOperations).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('aggregates seeded events into the shared payload', () => {
    const store = new MetricsStore(tempMetrics());
    try {
      store.record({
        timestamp: '2026-08-30T00:00:00.000Z',
        session_id: 's1',
        task_type: 'investigation',
        complexity: 'low',
        risk: 'low',
        tool: 'leanctx',
        operation: 'optimize_context',
        estimated_input_tokens: 1000,
        estimated_output_tokens: 100,
        estimated_tokens_saved: 900,
        compression_ratio: 0.1,
        optimisation_strategy: null,
      });
      store.record({
        timestamp: '2026-08-30T00:00:01.000Z',
        session_id: 's2',
        task_type: 'coding',
        complexity: 'medium',
        risk: 'low',
        tool: 'serena',
        operation: 'search',
        estimated_input_tokens: 2000,
        estimated_output_tokens: 200,
        estimated_tokens_saved: 100,
        compression_ratio: null,
        optimisation_strategy: null,
      });

      const payload = formatStats(store);
      expect(payload.estimated).toBe(true);
      expect(payload.count).toBe(2);
      expect(payload.totals.eventCount).toBe(1);
      expect(payload.totals.inputTokens).toBe(1000);
      expect(payload.totals.outputTokens).toBe(100);
      expect(payload.totals.tokensSaved).toBe(900);
      expect(payload.totals.reductionPct).toBe(90);
      // Savings by tool: only LeanCTX contributes.
      expect(payload.savingsByTool).toEqual([
        { key: 'leanctx', estimatedTokensSaved: 900 },
      ]);
      expect(payload.savingsByTaskType).toEqual([
        { key: 'investigation', estimatedTokensSaved: 900 },
      ]);
      expect(payload.sessions).toHaveLength(2);
      expect(payload.mostExpensiveOperations[0]!.operation).toBe('search');
    } finally {
      store.close();
    }
  });
});
