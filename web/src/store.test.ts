import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDashboardStore } from './store';

describe('dashboard store stream categorization (task 58)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('routes a steering request into steeringLogs only', () => {
    const store = useDashboardStore();
    store.handleEvent({ type: 'request', ts: 1, id: 'r1', tool: 'mcp', operation: 'steering' });
    expect(store.steeringLogs).toHaveLength(1);
    expect(store.procedureLogs).toHaveLength(0);
  });

  it('routes a procedure request into procedureLogs only', () => {
    const store = useDashboardStore();
    store.handleEvent({
      type: 'request',
      ts: 1,
      id: 'r1',
      tool: 'mcp',
      operation: 'procedure_apply',
    });
    expect(store.procedureLogs).toHaveLength(1);
    expect(store.steeringLogs).toHaveLength(0);
  });

  it('assigns a response to the category of its request by id', () => {
    const store = useDashboardStore();
    store.handleEvent({ type: 'request', ts: 1, id: 'r1', tool: 'mcp', operation: 'steering' });
    store.handleEvent({ type: 'response', ts: 2, id: 'r1', ok: true });
    expect(store.steeringLogs).toHaveLength(2);
    expect(store.procedureLogs).toHaveLength(0);
  });

  it('creates a procedures trace from think events', () => {
    const store = useDashboardStore();
    store.handleEvent({ type: 'llm.trace.think.start', ts: 1, id: 't1' });
    store.handleEvent({ type: 'llm.trace.think.token', ts: 2, id: 't1', delta: 'reasoning' });
    expect(store.procedureTraces).toHaveLength(1);
    expect(store.procedureTraces[0]?.thinking).toBe('reasoning');
    expect(store.steeringTraces).toHaveLength(0);
  });

  it('treats a steering llm trace as steering', () => {
    const store = useDashboardStore();
    store.handleEvent({
      type: 'llm.trace.start',
      ts: 1,
      id: 't1',
      model: 'qwen3:4b',
      request: 'x',
    });
    expect(store.steeringTraces).toHaveLength(1);
    expect(store.procedureTraces).toHaveLength(0);
  });
});
