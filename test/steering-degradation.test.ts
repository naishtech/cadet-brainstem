import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SteeringValidationError,
  SteeringUnavailableError,
  steerWithFallback,
  conservativeDefaultSteering,
  type Steering,
} from '../src/steering/index';

const okSteering: Steering = {
  task: 'debug',
  complexity: 'medium',
  risk: 'medium',
  context_need: 'broad',
  precision: 'normal',
  entities: [],
  tool_plan: {},
  response_policy: { directives: [] },
};

describe('conservativeDefaultSteering', () => {
  it('biases toward the highest context need and lowest risk', () => {
    expect(conservativeDefaultSteering.context_need).toBe('exhaustive');
    expect(conservativeDefaultSteering.risk).toBe('low');
    expect(conservativeDefaultSteering.task).toBe('investigation');
  });
});

describe('steerWithFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the real steering when steering succeeds', async () => {
    const outcome = await steerWithFallback(
      'fix it',
      {},
      async () => okSteering,
    );
    expect(outcome.degraded).toBe(false);
    expect(outcome.steering).toEqual(okSteering);
    expect(outcome.reason).toBeUndefined();
  });

  it('degrades to the conservative default when Ollama is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await steerWithFallback(
      'fix it',
      {},
      async () => {
        throw new SteeringUnavailableError('Ollama is down');
      },
    );
    expect(outcome.degraded).toBe(true);
    expect(outcome.steering).toEqual(conservativeDefaultSteering);
    expect(outcome.reason).toContain('Ollama is down');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('degraded'));
  });

  it('degrades on invalid/un-schema\'d output', async () => {
    const outcome = await steerWithFallback(
      'fix it',
      {},
      async () => {
        throw new SteeringValidationError('invalid enum: not-a-task');
      },
    );
    expect(outcome.degraded).toBe(true);
    expect(outcome.steering).toEqual(conservativeDefaultSteering);
    expect(outcome.reason).toContain('invalid enum');
  });

  it('rethrows unexpected errors instead of swallowing them', async () => {
    await expect(
      steerWithFallback(
        'fix it',
        {},
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
  });
});
