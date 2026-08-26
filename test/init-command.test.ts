import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import type { EnvironmentReport } from '../src/core/environment';
import { MetricsStore } from '../src/metrics';
import { runInit } from '../src/cli/commands/init';

const {
  downloadAndExtractZipMock,
  isModelAvailableMock,
  pullOllamaModelMock,
  startOllamaDockerMock,
} = vi.hoisted(() => ({
  downloadAndExtractZipMock: vi.fn(),
  isModelAvailableMock: vi.fn(),
  pullOllamaModelMock: vi.fn(),
  startOllamaDockerMock: vi.fn(),
}));

vi.mock('../src/core/installers', () => ({
  OLLAMA_MODEL: 'qwen3:1.7b',
  RTK_WINDOWS_URL: 'https://example.com/rtk.zip',
  LEANCTX_WINDOWS_URL: 'https://example.com/leanctx.zip',
  downloadAndExtractZip: downloadAndExtractZipMock,
  pullOllamaModel: pullOllamaModelMock,
  startOllamaDocker: startOllamaDockerMock,
}));

vi.mock('../src/classifier', () => ({
  DEFAULT_OLLAMA_HOST: 'http://localhost:11434',
  isModelAvailable: isModelAvailableMock,
}));

function makeReport(
  overrides: Partial<EnvironmentReport> = {},
): EnvironmentReport {
  const base: EnvironmentReport = {
    platform: 'windows',
    node: { name: 'node', available: true, detail: 'v25.2.1' },
    npm: { name: 'npm', available: true, detail: '11.6.2' },
    ollama: { name: 'ollama', available: true, detail: 'http://localhost:11434' },
    rtk: { name: 'rtk', available: true },
    serena: { name: 'serena', available: true },
    leanctx: { name: 'leanctx', available: true },
    availableTools: ['rtk', 'serena', 'leanctx'],
    missingTools: [],
  };
  return { ...base, ...overrides };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-init-'));
  downloadAndExtractZipMock.mockReset();
  isModelAvailableMock.mockReset();
  isModelAvailableMock.mockResolvedValue(false); // model missing by default
  pullOllamaModelMock.mockReset();
  startOllamaDockerMock.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInit', () => {
  it('creates config and metrics db on first run', async () => {
    const configPath = join(dir, 'config.yaml');
    const metricsPath = join(dir, 'metrics.db');
    const lines: string[] = [];

    const exit = await runInit({
      detect: async () => makeReport(),
      ask: async () => false,
      configPath,
      metricsPath,
      log: (line) => lines.push(line),
    });

    expect(exit).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(metricsPath)).toBe(true);
    expect(loadConfig(configPath).classifier.model).toBe('qwen3:1.7b');
    const out = lines.join('\n');
    expect(out).toContain('config created');
    expect(out).toContain('metrics database ready');
    expect(out).toContain('init complete');
  });

  it('is safe to run repeatedly (idempotent)', async () => {
    const configPath = join(dir, 'config.yaml');
    const metricsPath = join(dir, 'metrics.db');
    const deps = {
      detect: async () => makeReport(),
      ask: async () => false,
      configPath,
      metricsPath,
      log: () => undefined,
    };

    await runInit(deps);
    await runInit(deps);

    expect(loadConfig(configPath).classifier.model).toBe('qwen3:1.7b');
    const store = new MetricsStore(metricsPath);
    expect(store.count()).toBe(0);
    store.close();
  });

  it('does not attempt installs when the user declines consent', async () => {
    const report = makeReport({
      rtk: { name: 'rtk', available: false },
      availableTools: ['serena', 'leanctx'],
      missingTools: ['rtk'],
    });

    await runInit({
      detect: async () => report,
      ask: async () => false,
      configPath: join(dir, 'config.yaml'),
      metricsPath: join(dir, 'metrics.db'),
      log: () => undefined,
    });

    expect(downloadAndExtractZipMock).not.toHaveBeenCalled();
    expect(pullOllamaModelMock).not.toHaveBeenCalled();
  });

  it('installs a missing Windows tool when the user consents', async () => {
    downloadAndExtractZipMock.mockResolvedValue({
      ok: true,
      binPath: 'C:\\Users\\dev\\.local\\bin\\rtk.exe',
    });
    const report = makeReport({
      platform: 'windows',
      rtk: { name: 'rtk', available: false },
      availableTools: ['serena', 'leanctx'],
      missingTools: ['rtk'],
    });

    await runInit({
      detect: async () => report,
      ask: async () => true,
      configPath: join(dir, 'config.yaml'),
      metricsPath: join(dir, 'metrics.db'),
      log: () => undefined,
    });

    expect(downloadAndExtractZipMock).toHaveBeenCalledWith(
      'https://example.com/rtk.zip',
      expect.stringContaining('.local'),
      'rtk',
    );
  });

  it('pulls the classifier model when the user consents', async () => {
    pullOllamaModelMock.mockResolvedValue({ stdout: 'pulling…', stderr: '' });
    const lines: string[] = [];

    await runInit({
      detect: async () => makeReport(),
      ask: async () => true,
      configPath: join(dir, 'config.yaml'),
      metricsPath: join(dir, 'metrics.db'),
      log: (line) => lines.push(line),
    });

    expect(pullOllamaModelMock).toHaveBeenCalled();
    expect(lines.join('\n')).toContain('pulling');
  });

  it('does not offer to pull when the model is already present', async () => {
    isModelAvailableMock.mockResolvedValue(true);
    const lines: string[] = [];
    const ask = vi.fn(async () => true);

    await runInit({
      detect: async () => makeReport(),
      ask,
      configPath: join(dir, 'config.yaml'),
      metricsPath: join(dir, 'metrics.db'),
      log: (line) => lines.push(line),
    });

    expect(isModelAvailableMock).toHaveBeenCalled();
    expect(pullOllamaModelMock).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('already present');
  });

  it('prints a clear summary including missing tools', async () => {
    const report = makeReport({
      serena: { name: 'serena', available: false },
      availableTools: ['rtk', 'leanctx'],
      missingTools: ['serena'],
    });
    const lines: string[] = [];

    await runInit({
      detect: async () => report,
      ask: async () => false,
      configPath: join(dir, 'config.yaml'),
      metricsPath: join(dir, 'metrics.db'),
      log: (line) => lines.push(line),
    });

    const out = lines.join('\n');
    expect(out).toContain('MISSING');
    expect(out).toContain('Tools missing');
    expect(out).toContain('serena');
  });
});
