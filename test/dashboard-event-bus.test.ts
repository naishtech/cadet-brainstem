import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, getEventBus, type DashboardEvent } from '../src/dashboard/event-bus';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eb-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeBus(capacity = 10, persistLogs = false): EventBus {
  return new EventBus({
    capacity,
    persistLogs,
    persistPath: join(tempDir(), 'dashboard.log'),
  });
}

describe('EventBus', () => {
  it('round-trips events to subscribers', () => {
    const bus = makeBus();
    const received: DashboardEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.log('info', 'test', 'hello');

    expect(received).toHaveLength(1);
    const event = received[0] as Extract<DashboardEvent, { type: 'log' }>;
    expect(event.type).toBe('log');
    expect(event.level).toBe('info');
    expect(event.source).toBe('test');
    expect(event.message).toBe('hello');
    expect(typeof event.ts).toBe('number');
  });

  it('honours unsubscribe', () => {
    const bus = makeBus();
    let count = 0;
    const unsubscribe = bus.subscribe(() => {
      count += 1;
    });

    bus.statsUpdated();
    unsubscribe();
    bus.statsUpdated();

    expect(count).toBe(1);
  });

  it('ring buffer respects capacity and returns newest-first', () => {
    const bus = makeBus(3);
    for (let i = 0; i < 5; i += 1) {
      bus.log('info', 's', `m${i}`);
    }
    expect(bus.size()).toBe(3);

    const recent = bus.recent(10);
    expect(recent.map((e) => (e as Extract<DashboardEvent, { type: 'log' }>).message)).toEqual([
      'm4',
      'm3',
      'm2',
    ]);
  });

  it('recent supports limit and since', () => {
    const bus = makeBus(10);
    bus.publish({ type: 'stats.updated', ts: 1000 });
    bus.publish({ type: 'stats.updated', ts: 2000 });
    bus.publish({ type: 'stats.updated', ts: 3000 });

    const filtered = bus.recent(10, 2000); // inclusive: ts 3000 + 2000
    expect(filtered.map((e) => e.ts)).toEqual([3000, 2000]);
    expect(bus.recent(2).map((e) => e.ts)).toEqual([3000, 2000]);
  });

  it('publishes all convenience event types with a type', () => {
    const bus = makeBus();
    const types: string[] = [];
    bus.subscribe((event) => types.push(event.type));

    bus.log('warn', 's', 'msg');
    bus.requestStarted({ id: '1', tool: 'rtk', operation: 'compress' });
    bus.responded({ id: '1', ok: true, latencyMs: 5 });
    bus.status([{ name: 'ollama', available: true, detail: '0.5.1' }]);
    bus.traceStart({ id: 't1', model: 'qwen3:4b', request: 'hi' });
    bus.traceToken({ id: 't1', delta: 'think' });
    bus.traceComplete({ id: 't1', usage: { inputTokens: 10, outputTokens: 2 } });
    bus.statsUpdated();

    expect(types).toEqual([
      'log',
      'request',
      'response',
      'status',
      'llm.trace.start',
      'llm.trace.token',
      'llm.trace.complete',
      'stats.updated',
    ]);
  });

  it('persists valid JSONL when persistLogs is on', async () => {
    const dir = tempDir();
    const path = join(dir, 'dashboard.log');
    const bus = new EventBus({ capacity: 10, persistLogs: true, persistPath: path });

    bus.log('info', 's', 'hello');
    bus.statsUpdated();
    await bus.flush();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if not valid JSON
      expect(typeof parsed.ts).toBe('number');
    }
  });

  it('does not write when persistLogs is off', async () => {
    const dir = tempDir();
    const path = join(dir, 'dashboard.log');
    const bus = new EventBus({ capacity: 10, persistLogs: false, persistPath: path });

    bus.log('info', 's', 'hello');
    await bus.flush();

    expect(existsSync(path)).toBe(false);
  });
});

describe('singleton', () => {
  it('returns the same shared instance', () => {
    expect(getEventBus()).toBe(getEventBus());
  });
});
