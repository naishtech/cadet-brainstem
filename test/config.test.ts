import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from '../src/config/index';
import { defaultPolicies } from '../src/policy/index';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-config-'));
  tempDirs.push(dir);
  return dir;
}

function configPath(dir: string): string {
  return join(dir, 'config.yaml');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('default config', () => {
  it('matches the design doc §13 defaults', () => {
    expect(defaultConfig).toEqual({
      classifier: {
        provider: 'ollama',
        model: 'qwen3:1.7b',
        derived_model: 'fast-classifier',
        auto_build: true,
        timeout_ms: 60000,
        keep_alive: '30m',
      },
      session: { max_turns: 30 },
      optimisation: { enabled: true, default_budget: 12000 },
      telemetry: { enabled: false },
      tools: { rtk: true, serena: true, leanctx: true },
      memory: {},
      policies: defaultPolicies,
    });
  });
});

describe('loadConfig', () => {
  it('returns defaults when the config file is missing', () => {
    const dir = makeTempDir();
    expect(loadConfig(configPath(dir))).toEqual(defaultConfig);
  });

  it('returns defaults for an empty config file', () => {
    const dir = makeTempDir();
    writeFileSync(configPath(dir), '', 'utf8');
    expect(loadConfig(configPath(dir))).toEqual(defaultConfig);
  });

  it('fills defaults for a partial config', () => {
    const dir = makeTempDir();
    writeFileSync(configPath(dir), 'classifier:\n  model: llama3\n', 'utf8');
    const cfg = loadConfig(configPath(dir));
    expect(cfg.classifier).toEqual({
      provider: 'ollama',
      model: 'llama3',
      derived_model: 'fast-classifier',
      auto_build: true,
      timeout_ms: 60000,
      keep_alive: '30m',
    });
    expect(cfg.session.max_turns).toBe(30);
    expect(cfg.telemetry.enabled).toBe(false);
    expect(cfg.tools.leanctx).toBe(true);
  });

  it('throws a clear error for invalid values', () => {
    const dir = makeTempDir();
    writeFileSync(configPath(dir), 'session:\n  max_turns: "abc"\n', 'utf8');
    expect(() => loadConfig(configPath(dir))).toThrow(ConfigError);
    expect(() => loadConfig(configPath(dir))).toThrow(/Invalid config/);
  });

  it('throws a clear error for a non-object config', () => {
    const dir = makeTempDir();
    writeFileSync(configPath(dir), '- a\n- b\n', 'utf8'); // YAML array
    expect(() => loadConfig(configPath(dir))).toThrow(ConfigError);
  });
});

describe('saveConfig + round-trip', () => {
  it('writes YAML that loads back to the same object', () => {
    const dir = makeTempDir();
    const file = configPath(dir);
    const cfg = {
      ...defaultConfig,
      classifier: {
        provider: 'ollama' as const,
        model: 'custom-model',
        derived_model: 'custom-model',
        auto_build: true,
        timeout_ms: 45000,
        keep_alive: '15m',
      },
      session: { max_turns: 5 },
    };
    saveConfig(cfg, file);
    expect(loadConfig(file)).toEqual(cfg);
  });
});

describe('value access helpers', () => {
  it('reads individual values by dot path', () => {
    expect(getConfigValue(defaultConfig, 'classifier.model')).toBe('qwen3:1.7b');
    expect(getConfigValue(defaultConfig, 'session.max_turns')).toBe(30);
    expect(getConfigValue(defaultConfig, 'tools.rtk')).toBe(true);
    expect(getConfigValue(defaultConfig, 'nope.missing')).toBeUndefined();
  });

  it('sets and validates individual values', () => {
    const updated = setConfigValue(defaultConfig, 'classifier.model', 'qwen3:8b');
    expect(updated.classifier.model).toBe('qwen3:8b');
    expect(getConfigValue(updated, 'classifier.model')).toBe('qwen3:8b');
  });

  it('rejects invalid values on set', () => {
    expect(() => setConfigValue(defaultConfig, 'session.max_turns', 'many')).toThrow(ConfigError);
    expect(() => setConfigValue(defaultConfig, 'bogus.key', 1)).toThrow(ConfigError);
  });
});
