import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { defaultPolicies, policiesSchema } from '../policy/schema';

/** Raised when a config file is missing, empty, or contains invalid values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ── Schema (defaults match design doc §13) ────────────────────────────────

const classifierSchema = z.object({
  provider: z.enum(['ollama']),
  model: z.string().min(1, 'model must be a non-empty string'),
  derived_model: z
    .string()
    .min(1, 'derived_model must be a non-empty string')
    .optional(),
  timeout_ms: z
    .number()
    .int('timeout_ms must be an integer')
    .positive('timeout_ms must be positive'),
  keep_alive: z.string().min(1, 'keep_alive must be a non-empty string'),
});

const sessionSchema = z.object({
  max_turns: z
    .number()
    .int('max_turns must be an integer')
    .positive('max_turns must be positive'),
});

const optimisationSchema = z.object({
  enabled: z.boolean(),
  default_budget: z
    .number()
    .int('default_budget must be an integer')
    .positive('default_budget must be positive'),
});

const telemetrySchema = z.object({
  enabled: z.boolean(),
});

const toolsSchema = z.object({
  rtk: z.boolean(),
  serena: z.boolean(),
  leanctx: z.boolean(),
});

const memorySchema = z.object({
  active_project: z.string().min(1).optional(),
  projects: z.record(z.string(), z.string()).optional(),
});

export const configSchema = z.object({
  classifier: classifierSchema,
  session: sessionSchema,
  optimisation: optimisationSchema,
  telemetry: telemetrySchema,
  tools: toolsSchema,
  memory: memorySchema,
  policies: policiesSchema,
});

export type Config = z.infer<typeof configSchema>;

/**
 * Effective config when nothing is provided (design doc §13).
 * Single source of truth for defaults — partial configs are deep-merged on top
 * of this before validation.
 *
 * Note: the default classifier model is qwen3:1.7b (not §13's qwen3:4b) — a
 * smaller, faster model that classifies well within the latency budget on
 * CPU. Thinking is disabled in the Ollama adapter (see classifier/ollama.ts),
 * and keep_alive keeps the model warm between calls so a cold model reload
 * doesn't blow the timeout (see classifier/ollama.ts).
 */
export const defaultConfig: Config = {
  classifier: {
    provider: 'ollama',
    model: 'qwen3:1.7b',
    // Modelfile-derived classifier used at runtime (built via `ollama create
    // fast-classifier -f Modelfile`). Falls back to `model` if not set.
    derived_model: 'fast-classifier',
    timeout_ms: 60_000,
    keep_alive: '30m',
  },
  session: { max_turns: 30 },
  optimisation: { enabled: true, default_budget: 12000 },
  telemetry: { enabled: false },
  tools: { rtk: true, serena: true, leanctx: true },
  memory: {},
  policies: defaultPolicies,
};

// ── Config file location ──────────────────────────────────────────────────

const CONFIG_DIR = '.cadet-token-saver';

/**
 * Stable local config path.
 * Overridable via CADET_TOKEN_SAVER_CONFIG (useful for tests / non-default setups).
 */
export function getConfigPath(): string {
  const env = process.env.CADET_TOKEN_SAVER_CONFIG;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return join(os.homedir(), CONFIG_DIR, 'config.yaml');
}

// ── Load / save ───────────────────────────────────────────────────────────

/** Load config from disk, filling in defaults for any missing fields. */
export function loadConfig(filePath = getConfigPath()): Config {
  if (!existsSync(filePath)) {
    return structuredClone(defaultConfig);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `Could not parse config YAML at ${filePath}: ${(err as Error).message}`,
    );
  }

  // An empty file (YAML parses to null/undefined) is treated as "use all defaults".
  if (parsed === null || parsed === undefined) {
    return structuredClone(defaultConfig);
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Config file must contain a YAML object: ${filePath}`);
  }

  const merged = deepMerge(defaultConfig, parsed);
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error, filePath));
  }
  return result.data;
}

/** Validate and write config as clean, human-readable YAML. */
export function saveConfig(config: Config, filePath = getConfigPath()): void {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error, filePath));
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyYaml(result.data), 'utf8');
}

// ── Individual value access (used by the `config` command) ────────────────

/** Read a single value by dot path, e.g. "classifier.model". */
export function getConfigValue(config: Config, key: string): unknown {
  let current: unknown = config;
  for (const part of key.split('.')) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object' ||
      !(part in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a single value by dot path, returning a validated, normalised config. */
export function setConfigValue(config: Config, key: string, value: unknown): Config {
  const parts = key.split('.');
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new ConfigError(`Invalid config key: "${key}"`);
  }
  const clone = structuredClone(config) as unknown as Record<string, unknown>;
  setByPath(clone, parts, value);
  const result = configSchema.safeParse(clone);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error, key));
  }
  return result.data;
}

function setByPath(
  obj: Record<string, unknown>,
  parts: string[],
  value: unknown,
): void {
  const head = parts[0] as string;
  if (parts.length === 1) {
    obj[head] = value;
    return;
  }
  const next = obj[head];
  if (next === null || next === undefined || typeof next !== 'object' || Array.isArray(next)) {
    throw new ConfigError(`Cannot set "${parts.join('.')}": "${head}" is not a nested object`);
  }
  setByPath(next as Record<string, unknown>, parts.slice(1), value);
}

/** Recursively merge a partial override over a base object (scalars/arrays replace). */
function deepMerge<T>(base: T, override: unknown): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (
    override === null ||
    override === undefined ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return out as T;
  }
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const baseValue = (base as Record<string, unknown>)[key];
    if (
      baseValue !== null &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue) &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function formatIssues(error: z.ZodError, context: string): string {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `Invalid config (${context}): ${details}`;
}
