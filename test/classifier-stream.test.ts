import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaClassifier } from '../src/classifier/index';
import type { TraceSink } from '../src/classifier/index';

const validClassification = {
  task: 'debug',
  complexity: 'medium',
  risk: 'medium',
  context_need: 'broad',
  precision: 'normal',
  entities: ['checkout', 'payment'],
  tool_plan: {
    recommended_tools: [
      { name: 'find_relevant_symbols', intent: 'locate relevant symbols', priority: 1 },
    ],
  },
  response_policy: { directives: ['compact', 'no_filler'] },
};

function makeTrace() {
  return { start: vi.fn(), token: vi.fn(), complete: vi.fn() };
}

/** A streaming HTTP response body from NDJSON frames. */
function ndjsonResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

beforeEach(() => {
  process.env.CADET_BRAINSTEM_CONFIG = join(tmpdir(), `cts-stream-${process.pid}.yaml`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CADET_BRAINSTEM_CONFIG;
});

describe('LLM trace streaming', () => {
  it('streams reasoning tokens live and brackets with start/complete', async () => {
    const content = JSON.stringify(validClassification);
    const split = 10;
    const frames = [
      `${JSON.stringify({ message: { content: content.slice(0, split) } })}\n`,
      `${JSON.stringify({ message: { content: content.slice(split) } })}\n`,
      `${JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5 })}\n`,
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse(frames)));

    const trace = makeTrace();
    const classifier = new OllamaClassifier({
      model: 'test-model',
      host: 'http://localhost:11434',
      trace: trace as unknown as TraceSink,
    });

    const result = await classifier.classify('debug this');

    expect(result).toEqual(validClassification);
    expect(trace.start).toHaveBeenCalledTimes(1);
    expect(trace.token.mock.calls.length).toBeGreaterThanOrEqual(2);
    const deltaSum = trace.token.mock.calls
      .map((call) => (call[0] as { delta: string }).delta)
      .join('');
    expect(deltaSum).toBe(content);
    expect(trace.complete).toHaveBeenCalledTimes(1);
    expect(trace.complete.mock.calls[0]![0]).toMatchObject({
      id: expect.any(String),
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('falls back to non-streaming when streaming fails without breaking classification', async () => {
    const calls: Array<() => Promise<unknown>> = [
      async () => new Response(null, { status: 500 }), // streaming fails
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({ message: { content: JSON.stringify(validClassification) } }),
      }), // non-streaming fallback succeeds
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => calls.shift()!() as unknown as Response),
    );

    const trace = makeTrace();
    const classifier = new OllamaClassifier({
      model: 'test-model',
      host: 'http://localhost:11434',
      trace: trace as unknown as TraceSink,
    });

    const result = await classifier.classify('debug this');

    expect(result).toEqual(validClassification);
    expect(trace.start).toHaveBeenCalledTimes(1);
    expect(trace.token).not.toHaveBeenCalled();
    expect(trace.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps the original non-streaming behaviour when no trace sink is provided', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: JSON.stringify(validClassification) } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const classifier = new OllamaClassifier({
      model: 'test-model',
      host: 'http://localhost:11434',
    });

    const result = await classifier.classify('debug this');
    expect(result).toEqual(validClassification);

    const call = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { stream: boolean };
    expect(body.stream).toBe(false);
  });
});
