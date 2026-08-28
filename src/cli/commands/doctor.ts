import { existsSync } from 'node:fs';
import { DEFAULT_OLLAMA_HOST, isModelAvailable } from '../../classifier';
import {
  defaultConfig,
  getConfigPath,
  loadConfig,
  type Config,
} from '../../config';
import {
  detectEnvironment,
  type EnvironmentReport,
} from '../../core/environment';
import { getDefaultMetricsPath, MetricsStore } from '../../metrics';
import type { CliCommand } from '../types';

export interface DoctorDeps {
  /** Override environment detection (tests). */
  detect?: () => Promise<EnvironmentReport>;
  /** Override the config path (tests). */
  configPath?: string;
  /** Override the metrics db path (tests). */
  metricsPath?: string;
  /** Override the Ollama host (tests). */
  host?: string;
  /** Override the classifier model (tests). */
  model?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
}

export interface DoctorCheck {
  label: string;
  ok: boolean;
  /** Critical failures make `doctor` exit non-zero. */
  critical: boolean;
  detail?: string;
  /** Actionable fix shown when the check fails. */
  hint?: string;
}

/**
 * Build a check, omitting absent optional fields (exactOptionalPropertyTypes).
 * Params are typed `| undefined` so callers may pass `undefined` freely.
 */
function doctorCheck(args: {
  label: string;
  ok: boolean;
  critical: boolean;
  detail?: string | undefined;
  hint?: string | undefined;
}): DoctorCheck {
  return {
    label: args.label,
    ok: args.ok,
    critical: args.critical,
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
    ...(args.hint !== undefined ? { hint: args.hint } : {}),
  };
}

/**
 * Read-only environment health check (design doc §13).
 *
 * Exit-code convention:
 * - 0 — all critical checks pass (warnings are non-fatal; missing integration
 *   tools degrade gracefully, so they never block).
 * - 1 — a critical check failed (Node.js, an unloadable config, or an
 *   unopenable metrics database).
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const detect = deps.detect ?? detectEnvironment;
  const configPath = deps.configPath ?? getConfigPath();
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();
  const host = deps.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;

  const report = await detect();
  const checks: DoctorCheck[] = [];

  const node = report.node;
  checks.push(
    doctorCheck({
      label: 'Node.js',
      ok: node.available,
      critical: true,
      detail: node.detail,
      hint: node.available
        ? undefined
        : 'Install Node.js 18+: https://nodejs.org',
    }),
  );

  const npm = report.npm;
  checks.push(
    doctorCheck({
      label: 'npm',
      ok: npm.available,
      critical: false,
      detail: npm.detail,
      hint: npm.available
        ? undefined
        : 'npm ships with Node.js: https://nodejs.org',
    }),
  );

  const ollama = report.ollama;
  checks.push(
    doctorCheck({
      label: 'Ollama',
      ok: ollama.available,
      critical: false,
      detail: ollama.available
        ? host
        : `not reachable at ${host}`,
      hint: ollama.available
        ? undefined
        : 'Start Ollama (docker start ollama) or install: https://ollama.com',
    }),
  );

  // Configuration. Missing = warning (defaults are used); invalid = critical.
  let config: Config;
  try {
    config = loadConfig(configPath);
    const missing = !existsSync(configPath);
    checks.push(
      doctorCheck({
        label: 'Configuration',
        ok: !missing,
        critical: false,
        detail: missing
          ? 'not created — using defaults (run init)'
          : configPath,
        hint: missing ? 'Run: cadet-token-saver init' : undefined,
      }),
    );
  } catch (err) {
    config = defaultConfig;
    checks.push(
      doctorCheck({
        label: 'Configuration',
        ok: false,
        critical: true,
        detail: (err as Error).message,
        hint: 'Fix the config file, or run: cadet-token-saver init',
      }),
    );
  }

  // Classifier model (only checkable when Ollama is reachable). Prefer the
  // Modelfile-derived model actually used at runtime, falling back to the
  // pulled base model.
  const model =
    deps.model ??
    (config.classifier.derived_model || config.classifier.model);
  const derived = model === config.classifier.derived_model;
  if (ollama.available) {
    const modelOk = await isModelAvailable(model, host);
    checks.push(
      doctorCheck({
        label: 'Classifier model',
        ok: modelOk,
        critical: false,
        detail: modelOk ? model : `"${model}" not pulled`,
        hint: modelOk
          ? undefined
          : derived
            ? `Build it: ollama create ${model} -f Modelfile`
            : `Pull it: ollama pull ${model}`,
      }),
    );
  } else {
    checks.push(
      doctorCheck({
        label: 'Classifier model',
        ok: false,
        critical: false,
        detail: 'cannot check (Ollama down)',
        hint: derived
          ? `Start Ollama, then: ollama create ${model} -f Modelfile`
          : `Start Ollama, then: ollama pull ${model}`,
      }),
    );
  }

  // Integration tools (non-critical — they degrade gracefully).
  const toolHints: Record<string, (platform: string) => string> = {
    rtk: (platform) =>
      platform === 'windows'
        ? 'Download rtk-x86_64-pc-windows-msvc.zip from https://github.com/rtk-ai/rtk/releases and extract rtk.exe to ~/.local/bin'
        : 'Install per https://github.com/rtk-ai/rtk',
    serena: () =>
      'Install per its own documentation, then verify: serena --version',
    leanctx: (platform) =>
      platform === 'windows'
        ? 'Download lean-ctx-x86_64-pc-windows-msvc.zip from https://github.com/yvgude/lean-ctx/releases and extract lean-ctx.exe to ~/.local/bin'
        : 'Install per https://github.com/yvgude/lean-ctx',
  };
  const labels: Record<string, string> = {
    rtk: 'RTK',
    serena: 'Serena',
    leanctx: 'LeanCTX',
  };
  for (const name of ['rtk', 'serena', 'leanctx'] as const) {
    const tool = report[name];
    checks.push(
      doctorCheck({
        label: labels[name] ?? name,
        ok: tool.available,
        critical: false,
        detail: tool.detail,
        hint: tool.available ? undefined : toolHints[name]?.(report.platform),
      }),
    );
  }

  // Metrics database — read-only: never create the file, only inspect it.
  // Missing = warning (init creates it); corrupt/unopenable = critical.
  let metricsOk = true;
  let metricsCritical = false;
  let metricsDetail: string;
  if (!existsSync(metricsPath)) {
    metricsOk = false;
    metricsDetail = 'not created — run init';
  } else {
    try {
      const store = new MetricsStore(metricsPath);
      const count = store.count();
      store.close();
      metricsDetail = `${metricsPath} (${count} events)`;
    } catch (err) {
      metricsOk = false;
      metricsCritical = true;
      metricsDetail = (err as Error).message;
    }
  }
  checks.push(
    doctorCheck({
      label: 'Metrics database',
      ok: metricsOk,
      critical: metricsCritical,
      detail: metricsDetail,
      hint: metricsOk ? undefined : 'Run: cadet-token-saver init',
    }),
  );

  // Report.
  log('');
  log('Cadet Token Saver Doctor');
  log('------------------------');
  for (const check of checks) {
    log(
      `${check.ok ? '✓' : '✗'} ${check.label.padEnd(18)} ${
        check.detail ?? (check.ok ? 'ok' : 'not found')
      }`,
    );
    if (!check.ok && check.hint !== undefined) {
      log(`    Fix: ${check.hint}`);
    }
  }

  const criticalFailures = checks.filter((c) => !c.ok && c.critical);
  const warnings = checks.filter((c) => !c.ok && !c.critical);
  log('');
  if (criticalFailures.length > 0) {
    log(
      `✗ ${criticalFailures.length} critical check(s) failed — Cadet Token Saver cannot run properly (exit 1).`,
    );
    return 1;
  }
  if (warnings.length > 0) {
    log(
      `⚠ ${warnings.length} warning(s) — the tool still runs, but some features are unavailable (exit 0).`,
    );
  } else {
    log('✓ All checks passed.');
  }
  return 0;
}

export const doctorCommand: CliCommand = {
  name: 'doctor',
  description: 'Check environment health',
  usage: 'cadet-token-saver doctor',
  run(): Promise<number> {
    return runDoctor();
  },
};
