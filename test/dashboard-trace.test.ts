import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/dashboard/event-bus';
import { getTraceSink } from '../src/dashboard/trace';

function makeBus(): EventBus {
  return new EventBus({ capacity: 10, persistLogs: false, persistPath: 'x.log' });
}

describe('getTraceSink', () => {
  it('publishes llm.trace.start/token/complete to the event bus', () => {
    const bus = makeBus();
    const types: string[] = [];
    bus.subscribe((event) => types.push(event.type));

    const sink = getTraceSink(bus);
    sink.start({ id: 't1', model: 'qwen3:1.7b', request: 'hi' });
    sink.token({ id: 't1', delta: 'think' });
    sink.complete({ id: 't1', usage: { inputTokens: 5, outputTokens: 3 } });

    expect(types).toEqual(['llm.trace.start', 'llm.trace.token', 'llm.trace.complete']);
  });

  it('complete without usage publishes a complete with no usage field', () => {
    const bus = makeBus();
    const events: Array<Record<string, unknown>> = [];
    bus.subscribe((event) => events.push(event as unknown as Record<string, unknown>));

    const sink = getTraceSink(bus);
    sink.complete({ id: 't1' });

    const complete = events[0] as { type: string; id: string; usage?: unknown };
    expect(complete.type).toBe('llm.trace.complete');
    expect(complete.id).toBe('t1');
    expect('usage' in complete).toBe(false);
  });

  it('never throws on sink calls', () => {
    const sink = getTraceSink(makeBus());
    expect(() => sink.start({ id: 't1', model: 'm', request: 'r' })).not.toThrow();
    expect(() => sink.token({ id: 't1', delta: 'd' })).not.toThrow();
    expect(() => sink.complete({ id: 't1' })).not.toThrow();
  });
});
