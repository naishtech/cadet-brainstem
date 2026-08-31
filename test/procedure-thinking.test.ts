import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventBus } from '../src/dashboard/event-bus';
import { defaultFillArgs } from '../src/procedure/execute';
import type { ProcedureStep } from '../src/procedure';

let dir: string;

function writeConfig(think: boolean): void {
  const cfgFile = join(dir, 'config.yaml');
  writeFileSync(
    cfgFile,
    `classifier:\n  model: qwen3:4b\n  think: ${think}\n`,
    'utf8',
  );
  process.env.CADET_BRAINSTEM_CONFIG = cfgFile;
}

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-proc-think-'));
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_CONFIG;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('procedure fill-args thinking trace', () => {
  it('publishes llm.trace.think.* when classifier.think is enabled', async () => {
    writeConfig(true);
    mockChat('The file uses "old"; replace it with "new".', '{"arguments":{"needle":"old","repl":"new"}}');
    const bus = getEventBus();
    const events: string[] = [];
    const unsub = bus.subscribe((e) => events.push(e.type));
    try {
      await defaultFillArgs(step, dir);
    } finally {
      unsub();
    }
    expect(events).toContain('llm.trace.think.start');
    expect(events).toContain('llm.trace.think.token');
    expect(events).toContain('llm.trace.think.complete');
  });

  it('does not publish think events when classifier.think is off', async () => {
    writeConfig(false);
    mockChat('The file uses "old"; replace it with "new".', '{"arguments":{"needle":"old","repl":"new"}}');
    const bus = getEventBus();
    const events: string[] = [];
    const unsub = bus.subscribe((e) => events.push(e.type));
    try {
      await defaultFillArgs(step, dir);
    } finally {
      unsub();
    }
    expect(events).not.toContain('llm.trace.think.start');
  });
});
