import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Control the availability probe + warm-up without touching a real Ollama.
vi.mock('../src/steering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/steering')>();
  return {
    ...actual,
    isOllamaAvailable: vi.fn(),
    warmUpOllama: vi.fn(),
  };
});

import { steerTool, type McpDeps } from '../src/mcp';
import {
  LlmStatusTracker,
  isOllamaAvailable,
  warmUpOllama,
  type SteeringOutcome,
} from '../src/steering';
import type { OptimisationStrategy } from '../src/policy';

const mockedIsOllamaAvailable = vi.mocked(isOllamaAvailable);
const mockedWarmUpOllama = vi.mocked(warmUpOllama);

function makeSteering(): SteeringOutcome {
  return {
    steering: {
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      entities: ['loader'],
      tool_plan: {},
      response_policy: { directives: [] },
      guidance: 'x',
      memory: { use: false },
    },
    degraded: false,
  };
}

function makeStrategy(): OptimisationStrategy {
  return {
    context_need: 'broad',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'error-focused',
    leanctx_mode: 'cognitive',
  };
}

let dir: string;
let metricsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-recovery-'));
  metricsPath = join(dir, 'metrics.db');
  mockedIsOllamaAvailable.mockReset();
  mockedWarmUpOllama.mockReset();
  mockedWarmUpOllama.mockResolvedValue({
    ok: true,
    available: true,
    modelReady: true,
    latencyMs: 1,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(tracker: LlmStatusTracker): McpDeps {
  const steer = vi.fn(async () => makeSteering());
  return {
    steer,
    getStrategy: () => makeStrategy(),
    llmStatus: tracker,
    metricsPath,
  };
}

describe('steer / LLM availability state machine', () => {
  it('returns the real steering when the LLM is ready', async () => {
    const tracker = new LlmStatusTracker();
    tracker.set('ready');
    const result = await steerTool({ task: 'debug the loader' }, makeDeps(tracker));
    expect(result.degraded).toBe(false);
    expect(result.llm_status).toBe('ready');
    expect(result.notice).toBeUndefined();
    expect(result.procedures_unavailable).toBeUndefined();
  });

  it('fast-degrades with a warming notice while the LLM is warming up', async () => {
    const tracker = new LlmStatusTracker();
    tracker.set('warming');
    const deps = makeDeps(tracker);
    const result = await steerTool({ task: 'debug the loader' }, deps);
    expect(result.degraded).toBe(true);
    expect(result.llm_status).toBe('warming');
    expect(result.notice).toContain('warming up');
    expect(result.procedures_unavailable).toBe(true);
    // Must NOT call Ollama (fast path) — no stall on the cold load.
    expect(deps.steer).not.toHaveBeenCalled();
  });

  it('stays degraded (down) when Ollama is unreachable', async () => {
    mockedIsOllamaAvailable.mockResolvedValue(false);
    const tracker = new LlmStatusTracker();
    tracker.set('down');
    const deps = makeDeps(tracker);
    const result = await steerTool({ task: 'debug the loader' }, deps);
    expect(result.degraded).toBe(true);
    expect(result.llm_status).toBe('down');
    expect(result.notice).toContain('down');
    expect(result.procedures_unavailable).toBe(true);
    expect(deps.steer).not.toHaveBeenCalled();
    expect(mockedWarmUpOllama).not.toHaveBeenCalled();
    expect(tracker.status).toBe('down');
  });

  it('recovers automatically when Ollama comes back up', async () => {
    mockedIsOllamaAvailable.mockResolvedValue(true);
    // Hold the warm-up in flight so the response deterministically reports the
    // recovering (warming) state rather than racing to ready.
    let release: () => void = () => {};
    mockedWarmUpOllama.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, available: true, modelReady: true, latencyMs: 1 });
        }),
    );
    const tracker = new LlmStatusTracker();
    tracker.set('down');
    const deps = makeDeps(tracker);
    const result = await steerTool({ task: 'debug the loader' }, deps);
    // This call still returns fast conservative defaults (recovering -> warming).
    expect(result.degraded).toBe(true);
    expect(result.llm_status).toBe('warming');
    expect(result.notice).toContain('warming up');
    expect(result.procedures_unavailable).toBe(true);
    expect(deps.steer).not.toHaveBeenCalled();
    // Warm-up was kicked off; the tracker stays warming until it completes.
    expect(mockedWarmUpOllama).toHaveBeenCalled();
    expect(tracker.status).toBe('warming');
    // Complete the warm-up -> automatically recovers to ready.
    release();
    await vi.waitFor(() => expect(tracker.status).toBe('ready'));
  });
});
