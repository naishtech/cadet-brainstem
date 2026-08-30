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

/** Run `fn` with a temporary set of env vars, restoring the originals after. */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe('default config', () => {
  it('matches the design doc §13 defaults', () => {
    expect(defaultConfig).toEqual({
      classifier: {
        provider: 'ollama',
        model: 'qwen3:1.7b',
        auto_build: true,
        timeout_ms: 60000,
        keep_alive: '30m',
      },
      session: { max_turns: 30 },
      optimisation: { enabled: true, default_budget: 12000 },
      telemetry: { enabled: false },
      tools: { rtk: true, serena: true, leanctx: true },
      dashboard: {
        enabled: true,
        host: '127.0.0.1',
        port: 4100,
        autoOpen: true,
        autoOpenNonInteractive: false,
        statusIntervalSec: 30,
        logRetention: 500,
        persistLogs: true,
        captureFull: true,
      },
      memory: {},
      policies: defaultPolicies,
    });
  });
});

describe('dashboard config', () => {
  it('defaults match the design doc §8', () => {
    const dir = makeTempDir();
    const cfg = loadConfig(configPath(dir));
    expect(cfg.dashboard).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 4100,
      autoOpen: true,
      autoOpenNonInteractive: false,
      statusIntervalSec: 30,
      logRetention: 500,
      persistLogs: true,
      captureFull: true,
    });
  });

  it('applies CADET_BRAINSTEM_DASHBOARD_* env overrides', () => {
    const dir = makeTempDir();
    withEnv(
      {
        CADET_BRAINSTEM_DASHBOARD_PORT: '4400',
        CADET_BRAINSTEM_DASHBOARD_ENABLED: 'false',
        CADET_BRAINSTEM_DASHBOARD_HOST: '0.0.0.0',
      },
      () => {
        const cfg = loadConfig(configPath(dir));
        expect(cfg.dashboard.port).toBe(4400);
        expect(cfg.dashboard.enabled).toBe(false);
        expect(cfg.dashboard.host).toBe('0.0.0.0');
      },
    );
  });

  it('rejects an invalid env override value', () => {
    const dir = makeTempDir();
    withEnv({ CADET_BRAINSTEM_DASHBOARD_PORT: 'not-a-port' }, () => {
      expect(() => loadConfig(configPath(dir))).toThrow(ConfigError);
    });
  });

  it('throws a clear error for an invalid dashboard config', () => {
    const dir = makeTempDir();
    writeFileSync(configPath(dir), 'dashboard:\n  port: "abc"\n', 'utf8');
    expect(() => loadConfig(configPath(dir))).toThrow(ConfigError);
    expect(() => loadConfig(configPath(dir))).toThrow(/Invalid config/);
  });

  it('reads dashboard values by dot path', () => {
    expect(getConfigValue(defaultConfig, 'dashboard.port')).toBe(4100);
    expect(getConfigValue(defaultConfig, 'dashboard.enabled')).toBe(true);
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
