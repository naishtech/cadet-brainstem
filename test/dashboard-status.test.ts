import { describe, expect, it } from 'vitest';
import { getServiceStatus } from '../src/dashboard/status';
import type { EnvironmentReport } from '../src/core/environment';

function tool(name: string, available: boolean, detail?: string) {
  return { name, available, ...(detail !== undefined ? { detail } : {}) };
}

function report(
  overrides: Partial<Pick<EnvironmentReport, 'ollama' | 'rtk' | 'serena' | 'leanctx'>> = {},
): EnvironmentReport {
  return {
    platform: 'linux',
    node: tool('node', true, 'v20'),
    npm: tool('npm', true, '9.0'),
    ollama: tool('ollama', true, 'http://localhost:11434'),
    rtk: tool('rtk', false),
    serena: tool('serena', true, '1.0.0'),
    leanctx: tool('leanctx', true, '2.0.0'),
    availableTools: ['serena', 'leanctx'],
    missingTools: ['rtk'],
    ...overrides,
  };
}

describe('getServiceStatus', () => {
  it('reports all four services with kinds', async () => {
    const status = await getServiceStatus({
      model: 'qwen3:1.7b',
      detect: async () => report(),
      modelAvailable: async () => true,
    });
    expect(status).toHaveLength(4);
    expect(status.map((s) => s.kind)).toEqual(['llm', 'rtk', 'serena', 'leanctx']);
    expect(status.find((s) => s.name === 'ollama')).toMatchObject({
      available: true,
      kind: 'llm',
    });
    expect(status.find((s) => s.name === 'rtk')?.available).toBe(false);
    expect(status.find((s) => s.name === 'serena')?.detail).toBe('1.0.0');
  });

  it('flags llm unavailable when the classifier model is missing', async () => {
    const status = await getServiceStatus({
      model: 'qwen3:1.7b',
      detect: async () => report(),
      modelAvailable: async () => false,
    });
    const llm = status.find((s) => s.kind === 'llm')!;
    expect(llm.available).toBe(false);
    expect(llm.detail).toContain('model');
  });

  it('uses the configured model by default via getConfig', async () => {
    let capturedModel = '';
    const status = await getServiceStatus({
      detect: async () => report(),
      modelAvailable: async (model) => {
        capturedModel = model;
        return true;
      },
      getConfig: () => ({ classifier: { model: 'custom-model' } }),
    });
    expect(capturedModel).toBe('custom-model');
    expect(status.find((s) => s.kind === 'llm')?.available).toBe(true);
  });

  it('does not throw when config is invalid', async () => {
    const status = await getServiceStatus({
      detect: async () => report(),
      modelAvailable: async () => false,
      getConfig: () => {
        throw new Error('bad config');
      },
    });
    // model resolves to '' -> model check skipped, llm reflects Ollama reachability
    expect(status.find((s) => s.kind === 'llm')?.available).toBe(true);
  });
});
