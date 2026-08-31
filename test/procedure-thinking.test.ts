import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventBus } from '../src/dashboard/event-bus';
import { defaultFillArgs } from '../src/procedure/execute';
import type { ProcedureStep } from '../src/procedure';

/** Mock Ollama /api/chat to return a reasoning block plus the arguments JSON. */
function mockChat(reasoning: string, content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: { reasoning_content: reasoning, content } }),
    })),
  );
}

const step: ProcedureStep = {
  service: 'serena',
  tool: 'replace_content',
  args: { needle: 'old', repl: 'new' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('procedure fill-args thinking trace', () => {
  it('always publishes llm.trace.think.* while running a procedure (procedures always think)', async () => {
    mockChat('The file uses "old"; replace it with "new".', '{"arguments":{"needle":"old","repl":"new"}}');
    const bus = getEventBus();
    const events: string[] = [];
    const unsub = bus.subscribe((e) => events.push(e.type));
    try {
      await defaultFillArgs(step, 'C:/repo');
    } finally {
      unsub();
    }
    expect(events).toContain('llm.trace.think.start');
    expect(events).toContain('llm.trace.think.token');
    expect(events).toContain('llm.trace.think.complete');
  });
});
