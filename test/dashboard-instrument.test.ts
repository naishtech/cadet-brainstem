import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/dashboard/event-bus';
import { createInstrumenter } from '../src/dashboard/instrument';

function makeBus(): EventBus {
  return new EventBus({ capacity: 10, persistLogs: false, persistPath: 'x.log' });
}

describe('createInstrumenter', () => {
  it('truncates hints when captureFull is false', () => {
    const bus = makeBus();
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe((event) => received.push(event as unknown as Record<string, unknown>));

    const instrument = createInstrumenter({ captureFull: false, eventBus: bus });
    const long = 'x'.repeat(500);
    instrument.requestStarted({ id: '1', tool: 'rtk', operation: 'wrap', inputHint: long });
    instrument.responded({ id: '1', ok: true, outputHint: long });

    const request = received[0]! as { type: string; inputHint: string };
    const response = received[1]! as { type: string; outputHint: string };
    expect(request.type).toBe('request');
    expect(request.inputHint.length).toBeLessThan(500);
    expect(response.type).toBe('response');
    expect(response.outputHint.length).toBeLessThan(500);
  });

  it('keeps full hints when captureFull is true', () => {
    const bus = makeBus();
    const received: Array<{ type: string; inputHint?: string }> = [];
    bus.subscribe((event) => received.push(event as unknown as { type: string; inputHint?: string }));

    const instrument = createInstrumenter({ captureFull: true, eventBus: bus });
    instrument.requestStarted({ id: '1', tool: 'rtk', operation: 'wrap', inputHint: 'full' });

    expect(received[0]!.type).toBe('request');
    expect(received[0]!.inputHint).toBe('full');
  });

  it('statsUpdated publishes a stats.updated event', () => {
    const bus = makeBus();
    const types: string[] = [];
    bus.subscribe((event) => types.push(event.type));

    createInstrumenter({ eventBus: bus }).statsUpdated();
    expect(types).toContain('stats.updated');
  });

  it('never throws on instrumentation calls', () => {
    const instrument = createInstrumenter({ eventBus: makeBus() });
    expect(() => instrument.requestStarted({ id: '1', tool: 't', operation: 'o' })).not.toThrow();
    expect(() => instrument.responded({ id: '1', ok: true })).not.toThrow();
    expect(() => instrument.log('info', 'source', 'message')).not.toThrow();
    expect(() => instrument.statsUpdated()).not.toThrow();
  });
});
