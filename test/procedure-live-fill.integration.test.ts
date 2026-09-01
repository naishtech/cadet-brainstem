/**
 * Live-model integration test for `defaultFillArgs` (procedure arg filling).
 *
 * Regression test: `defaultFillArgs` used to send `think: true` with a tight
 * `num_predict: 600` budget. On qwen3:4b the reasoning consumed the whole
 * token budget, so Ollama returned an empty `message.content`, and
 * `defaultFillArgs` threw "Ollama returned an empty response while filling
 * args". This test reproduces that against the real model and guards the fix.
 *
 * Gated on the live model — skipped when Ollama / the model are unavailable.
 */
import { describe, expect, it } from 'vitest';
import { defaultFillArgs } from '../src/procedure/execute';
import { isModelAvailable, isOllamaAvailable, resolveBaseModel } from '../src/steering';
import type { ProcedureStep } from '../src/procedure';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const MODEL = resolveBaseModel();

const step: ProcedureStep = {
  service: 'serena',
  tool: 'create_text_file',
  // Args intentionally empty — the live model must fill them from the handoff.
  args: {},
};

/** Matches the seeded create_text_file procedure's handoff shape. */
const HANDOFF =
  'To create a file, call create_text_file with { relative_path: "<bare filename>", content: "<text>" }. Keep relative_path a bare filename (no directories).';

const ollamaUp = await isOllamaAvailable(HOST);
const modelUp = ollamaUp ? await isModelAvailable(MODEL, HOST) : false;
const run = modelUp ? describe : describe.skip;

run('defaultFillArgs against the live model (create_text_file)', () => {
  it('returns non-empty arguments instead of an empty response', async () => {
    const args = (await defaultFillArgs(step, 'C:/repo', HANDOFF)) as {
      relative_path?: unknown;
      content?: unknown;
    };
    expect(typeof args.relative_path).toBe('string');
    expect(String(args.relative_path).length).toBeGreaterThan(0);
    expect(typeof args.content).toBe('string');
    expect(String(args.content).length).toBeGreaterThan(0);
  }, 120_000);
});
