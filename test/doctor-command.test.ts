import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/cli/commands/doctor';
import { defaultConfig, saveConfig } from '../src/config';
import type { EnvironmentReport } from '../src/core/environment';
import { MetricsStore } from '../src/metrics';

const { isModelAvailableMock } = vi.hoisted(() => ({
  isModelAvailableMock: vi.fn(),
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
    rtk: { name: 'rtk', available: true, detail: 'rtk 0.45.0' },
    serena: { name: 'serena', available: true, detail: 'Serena 1.7.0' },
    leanctx: { name: 'leanctx', available: true, detail: 'lean-ctx 3.9.19' },
    availableTools: ['rtk', 'serena', 'leanctx'],
    missingTools: [],
  };
  return { ...base, ...overrides };
}

let dir: string;

function paths() {
  return {
    configPath: join(dir, 'config.yaml'),
    metricsPath: join(dir, 'metrics.db'),
  };
}

function createHealthyState(): { configPath: string; metricsPath: string } {
  const { configPath, metricsPath } = paths();
  saveConfig(defaultConfig, configPath);
  const store = new MetricsStore(metricsPath);
  store.close();
  return { configPath, metricsPath };
}

async function run(opts: {
  report?: EnvironmentReport;
  modelOk?: boolean;
  configPath?: string;
  metricsPath?: string;
}): Promise<{ exit: number; lines: string[] }> {
  isModelAvailableMock.mockResolvedValue(opts.modelOk ?? true);
  const lines: string[] = [];
  const exit = await runDoctor({
    detect: async () => opts.report ?? makeReport(),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    ...(opts.metricsPath !== undefined ? { metricsPath: opts.metricsPath } : {}),
    log: (line) => lines.push(line),
  });
  return { exit, lines };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-doctor-'));
  isModelAvailableMock.mockResolvedValue(true);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  isModelAvailableMock.mockReset();
});

describe('runDoctor', () => {
  it('reports all green and exits 0 on a healthy setup', async () => {
    const { configPath, metricsPath } = createHealthyState();
    const { exit, lines } = await run({ configPath, metricsPath });
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('Cadet Brainstem Doctor');
    expect(out).toContain('✓ Node.js');
    expect(out).toContain('✓ npm');
    expect(out).toContain('✓ Ollama');
    expect(out).toContain('✓ Classifier model');
    expect(out).toContain('✓ RTK');
    expect(out).toContain('✓ Serena');
    expect(out).toContain('✓ LeanCTX');
    expect(out).toContain('✓ Configuration');
    expect(out).toContain('✓ Metrics database');
    expect(out).toContain('All checks passed');
  });

  it('warns (not fails) when config and metrics are missing, with run-init hints', async () => {
    const { configPath, metricsPath } = paths();
    const { exit, lines } = await run({ configPath, metricsPath });
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('not created — using defaults');
    expect(out).toContain('Run: cadet-brainstem init');
    expect(out).toContain('not created — run init');
    expect(out).toContain('warning(s)');
  });

  it('warns for missing integration tools with actionable Windows fixes', async () => {
    const { configPath, metricsPath } = createHealthyState();
    const report = makeReport({
      rtk: { name: 'rtk', available: false },
      serena: { name: 'serena', available: false },
      leanctx: { name: 'leanctx', available: false },
      availableTools: [],
      missingTools: ['rtk', 'serena', 'leanctx'],
    });
    const { exit, lines } = await run({ report, configPath, metricsPath });
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('✗ RTK');
    expect(out).toContain('rtk-x86_64-pc-windows-msvc.zip');
    expect(out).toContain('✗ Serena');
    expect(out).toContain('serena --version');
    expect(out).toContain('✗ LeanCTX');
    expect(out).toContain('lean-ctx-x86_64-pc-windows-msvc.zip');
  });

  it('warns with a build hint when the derived model is not present', async () => {
    const { configPath, metricsPath } = paths();
    saveConfig(
      {
        ...defaultConfig,
        classifier: { ...defaultConfig.classifier, derived_model: 'fast-classifier' },
      },
      configPath,
    );
    const store = new MetricsStore(metricsPath);
    store.close();
    const { exit, lines } = await run({ modelOk: false, configPath, metricsPath });
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(isModelAvailableMock).toHaveBeenCalled();
    expect(out).toContain('"fast-classifier" not pulled');
    expect(out).toContain('ollama create fast-classifier -f Modelfile');
  });

  it('exits 1 when Node.js is unavailable (critical)', async () => {
    const { configPath, metricsPath } = createHealthyState();
    const report = makeReport({
      node: { name: 'node', available: false },
    });
    const { exit, lines } = await run({ report, configPath, metricsPath });
    const out = lines.join('\n');

    expect(exit).toBe(1);
    expect(out).toContain('✗ Node.js');
    expect(out).toContain('critical check(s) failed');
  });

  it('exits 1 when the config exists but is invalid (critical)', async () => {
    const { configPath, metricsPath } = createHealthyState();
    writeFileSync(configPath, 'classifier: [unclosed\n', 'utf8');
    const { exit, lines } = await run({ configPath, metricsPath });

    expect(exit).toBe(1);
    expect(lines.join('\n')).toContain('critical check(s) failed');
  });

  it('does not perform any writes or installs (read-only)', async () => {
    const { configPath, metricsPath } = paths(); // neither created yet
    const { exit } = await run({ configPath, metricsPath });

    expect(exit).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(metricsPath)).toBe(false);
  });
});
