import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClassificationValidationError,
  ClassifierUnavailableError,
  classifyWithFallback,
  conservativeDefaultClassification,
  type Classification,
} from '../src/classifier/index';

const okClassification: Classification = {
  task: 'debug',
  complexity: 'medium',
  risk: 'medium',
  context_need: 'broad',
  precision: 'normal',
  tool_plan: { use: [] },
  response_policy: { directives: [] },
};

describe('conservativeDefaultClassification', () => {
  it('biases toward the highest context need and lowest risk', () => {
    expect(conservativeDefaultClassification.context_need).toBe('exhaustive');
    expect(conservativeDefaultClassification.risk).toBe('low');
    expect(conservativeDefaultClassification.task).toBe('investigation');
  });
});

describe('classifyWithFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the real classification when classification succeeds', async () => {
    const outcome = await classifyWithFallback(
      'fix it',
      {},
      async () => okClassification,
    );
    expect(outcome.degraded).toBe(false);
    expect(outcome.classification).toEqual(okClassification);
    expect(outcome.reason).toBeUndefined();
  });

  it('degrades to the conservative default when Ollama is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await classifyWithFallback(
      'fix it',
      {},
      async () => {
        throw new ClassifierUnavailableError('Ollama is down');
      },
    );
    expect(outcome.degraded).toBe(true);
    expect(outcome.classification).toEqual(conservativeDefaultClassification);
    expect(outcome.reason).toContain('Ollama is down');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('degraded'));
  });

  it('degrades on invalid/un-schema\'d output', async () => {
    const outcome = await classifyWithFallback(
      'fix it',
      {},
      async () => {
        throw new ClassificationValidationError('invalid enum: not-a-task');
      },
    );
    expect(outcome.degraded).toBe(true);
    expect(outcome.classification).toEqual(conservativeDefaultClassification);
    expect(outcome.reason).toContain('invalid enum');
  });

  it('rethrows unexpected errors instead of swallowing them', async () => {
    await expect(
      classifyWithFallback(
        'fix it',
        {},
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
  });
});
