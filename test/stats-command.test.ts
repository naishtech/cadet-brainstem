import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStats, runStatsClear } from '../src/cli/commands/stats';
import {
  MetricsStore,
  type OptimisationEvent,
} from '../src/metrics';

function makeEvent(overrides: Partial<OptimisationEvent> = {}): OptimisationEvent {
  return {
    timestamp: '2026-08-26T10:00:00.000Z',
    session_id: 'sess-1',
    task_type: 'debug',
    complexity: 'medium',
    risk: 'medium',
    tool: 'leanctx',
    operation: 'compress',
    estimated_input_tokens: 10000,
    estimated_output_tokens: 2000,
    estimated_tokens_saved: 8000,
    compression_ratio: 0.8,
    optimisation_strategy: 'normal',
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-stats-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedStore(metricsPath: string, events: OptimisationEvent[]): void {
  const store = new MetricsStore(metricsPath);
  for (const event of events) {
    store.record(event);
  }
  store.close();
}

async function run(metricsPath: string): Promise<{ exit: number; lines: string[] }> {
  const lines: string[] = [];
  const exit = await runStats({ metricsPath, log: (line) => lines.push(line) });
  return { exit, lines };
}

describe('runStats', () => {
  it('shows a friendly empty state when no events exist', async () => {
    const metricsPath = join(dir, 'metrics.db');
    const store = new MetricsStore(metricsPath);
    store.close();

    const { exit, lines } = await run(metricsPath);
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('No optimisation events recorded yet.');
    expect(out).not.toContain('Tokens saved');
  });

  it('prints summary stats derived from the actual rows', async () => {
    const metricsPath = join(dir, 'metrics.db');
    seedStore(metricsPath, [
      makeEvent(),
      makeEvent({
        session_id: 'sess-1',
        task_type: 'debug',
        tool: 'rtk',
        estimated_input_tokens: 5000,
        estimated_output_tokens: 1000,
        estimated_tokens_saved: 4000,
      }),
      makeEvent({
        session_id: 'sess-2',
        task_type: 'refactor',
        tool: 'serena',
        operation: 'find_symbols',
        estimated_input_tokens: 2000,
        estimated_output_tokens: 500,
        estimated_tokens_saved: 1500,
        compression_ratio: 0.75,
      }),
    ]);

    const { exit, lines } = await run(metricsPath);
    const out = lines.join('\n');

    expect(exit).toBe(0);
    // Totals: 3 events, input 17000, output 3500, saved 13500, reduction 79%.
    expect(out).toContain('Events:            3');
    expect(out).toContain('17,000');
    expect(out).toContain('3,500');
    expect(out).toContain('13,500');
    expect(out).toContain('79%');

    // Savings by tool: leanctx 8000, rtk 4000, serena 1500.
    expect(out).toContain('Savings by tool:');
    expect(out).toContain('leanctx');
    expect(out).toContain('8,000 tokens');

    // By task type: debug 12000, refactor 1500.
    expect(out).toContain('Savings by task type:');
    expect(out).toContain('debug');
    expect(out).toContain('12,000 tokens');

    // Local tool calls: no ollama seeded, one each for leanctx/rtk/serena.
    expect(out).toContain('Local tool calls:');
    expect(out).toContain('ollama');
    expect(out).toContain('0 call(s)');
    expect(out).toContain('1 call(s)');

    // Sessions: sess-1 (12000), sess-2 (1500).
    expect(out).toContain('Sessions:');
    expect(out).toContain('sess-1');
    expect(out).toContain('12,000 tokens saved');

    // Most expensive first: leanctx compress (10000 in), then rtk (5000).
    expect(out).toContain('Most expensive operations:');
    expect(out).toContain('10,000 in');

    // Estimates clearly labelled.
    expect(out).toContain('(estimate)');
    expect(out).toContain('All figures are ESTIMATES');
  });

  it('shows degraded counts and average latency per tool', async () => {
    const metricsPath = join(dir, 'metrics.db');
    seedStore(metricsPath, [
      makeEvent({ tool: 'ollama', operation: 'classify', degraded: false, latency_ms: 100 }),
      makeEvent({ tool: 'ollama', operation: 'classify', degraded: true, latency_ms: 5000 }),
      makeEvent({ tool: 'leanctx', degraded: false, latency_ms: 250 }),
    ]);

    const { exit, lines } = await run(metricsPath);
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('Local tool calls:');
    expect(out).toContain('ollama');
    expect(out).toContain('1 call(s) · 1 degraded · avg 100ms');
    expect(out).toContain('leanctx');
    expect(out).toContain('1 call(s) · avg 250ms');
    expect(out).toContain('0 call(s)'); // rtk/serena unseeded
  });

  it('exits 1 when the metrics database cannot be opened', async () => {
    // Make the parent path a file so MetricsStore's mkdirSync(dirname) throws
    // (ENOTDIR) — a reliable constructor failure.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const badPath = join(blocker, 'metrics.db');
    const { exit, lines } = await run(badPath);

    expect(exit).toBe(1);
    expect(lines.join('\n')).toContain('could not open metrics database');
  });
});

describe('runStatsClear', () => {
  function runClear(
    metricsPath: string,
    ask: (question: string) => Promise<boolean>,
  ): Promise<{ exit: number; lines: string[] }> {
    const lines: string[] = [];
    return runStatsClear({ metricsPath, ask, log: (line) => lines.push(line) }).then(
      (exit) => ({ exit, lines }),
    );
  }

  it('clears metrics after confirmation and reports the count', async () => {
    const metricsPath = join(dir, 'metrics.db');
    seedStore(metricsPath, [makeEvent(), makeEvent()]);

    const { exit, lines } = await runClear(metricsPath, async () => true);

    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('Cleared 2 event(s).');
    const store = new MetricsStore(metricsPath);
    expect(store.count()).toBe(0);
    store.close();
  });

  it('leaves metrics intact when confirmation is declined', async () => {
    const metricsPath = join(dir, 'metrics.db');
    seedStore(metricsPath, [makeEvent()]);

    const { exit, lines } = await runClear(metricsPath, async () => false);

    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('Aborted');
    const store = new MetricsStore(metricsPath);
    expect(store.count()).toBe(1);
    store.close();
  });

  it('defaults to no (no data loss) when non-interactive', async () => {
    const metricsPath = join(dir, 'metrics.db');
    seedStore(metricsPath, [makeEvent()]);
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => false,
    });
    try {
      const exit = await runStatsClear({
        metricsPath,
        log: (line) => lines.push(line),
      });
      expect(exit).toBe(0);
    } finally {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
      consoleSpy.mockRestore();
    }
    expect(lines.join('\n')).toContain('Aborted');
    const store = new MetricsStore(metricsPath);
    expect(store.count()).toBe(1);
    store.close();
  });
});
