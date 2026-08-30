import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, type DashboardEvent } from '../src/dashboard/event-bus';
import { JsonlTailer } from '../src/dashboard/jsonl-tail';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('JsonlTailer cross-process bridge', () => {
  let dir: string;
  let path: string;
  let bus: EventBus;
  let received: DashboardEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cadet-jsonl-'));
    path = join(dir, 'dashboard.log');
    bus = new EventBus({ capacity: 500, persistLogs: false, persistPath: path });
    received = [];
    unsubscribe = bus.subscribe((e) => received.push(e));
  });

  afterEach(() => {
    unsubscribe();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hydrates events written by another process without broadcasting them', async () => {
    const foreign: DashboardEvent[] = [
      { type: 'llm.trace.start', ts: 1, id: 'a', model: 'qwen3:4b', request: 'x' },
      { type: 'llm.trace.token', ts: 2, id: 'a', delta: 'hello' },
      { type: 'llm.trace.complete', ts: 3, id: 'a', usage: { inputTokens: 10, outputTokens: 2 } },
    ];
    writeFileSync(path, foreign.map((e) => `${JSON.stringify(e)}\n`).join(''));

    const tailer = new JsonlTailer({ path, bus, intervalMs: 50 });
    tailer.start();
    await wait(150);
    tailer.stop();

    // Hydrated into the buffer (visible via recent()) but not broadcast.
    expect(bus.recent(100).length).toBe(3);
    expect(received).toEqual([]);
  });

  it('broadcasts newly appended events and does not duplicate the bus own publish', async () => {
    // Seed a line that the *same* process published (goes through publish -> persisted).
    const own: DashboardEvent = { type: 'log', ts: 10, level: 'info', source: 'x', message: 'own' };
    bus.publish(own);
    // Simulate it landing on disk as a persisted line.
    appendFileSync(path, `${JSON.stringify(own)}\n`);

    const tailer = new JsonlTailer({ path, bus, intervalMs: 50 });
    tailer.start();
    await wait(100);

    // A foreign process appends a trace event.
    const foreign: DashboardEvent = {
      type: 'llm.trace.start',
      ts: 11,
      id: 'b',
      model: 'qwen3:4b',
      request: 'y',
    };
    appendFileSync(path, `${JSON.stringify(foreign)}\n`);
    await wait(150);
    tailer.stop();

    // own event broadcast exactly once (in-process), foreign event broadcast once.
    const ownBroadcasts = received.filter((e) => e.type === 'log').length;
    const foreignBroadcasts = received.filter(
      (e) => e.type === 'llm.trace.start' && e.id === 'b',
    ).length;
    expect(ownBroadcasts).toBe(1);
    expect(foreignBroadcasts).toBe(1);
    // Both present in the buffer.
    expect(bus.recent(100).some((e) => e.type === 'llm.trace.start' && e.id === 'b')).toBe(true);
  });

  it('recovers after the file is truncated/rotated', async () => {
    writeFileSync(path, '');
    const tailer = new JsonlTailer({ path, bus, intervalMs: 50 });
    tailer.start();
    await wait(50);

    appendFileSync(
      path,
      `${JSON.stringify({ type: 'log', ts: 1, level: 'info', source: 's', message: 'first' })}\n`,
    );
    // Simulate rotation: shrink the file.
    writeFileSync(path, '');
    await wait(50);
    appendFileSync(
      path,
      `${JSON.stringify({ type: 'log', ts: 2, level: 'info', source: 's', message: 'second' })}\n`,
    );
    await wait(150);
    tailer.stop();

    expect(received.some((e) => e.type === 'log' && (e as { message: string }).message === 'second')).toBe(true);
  });
});
