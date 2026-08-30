import { loadConfig } from '../../config';
import type { CliCommand } from '../types';

export interface DashboardDeps {
  /** Override the config loader (tests). */
  load?: typeof loadConfig;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
}

/** Effective dashboard settings (design doc §8, §9.1). */
export interface DashboardOptions {
  host: string;
  port: number;
  autoOpen: boolean;
  autoOpenNonInteractive: boolean;
  enabled: boolean;
}

/**
 * Parse dashboard CLI flags on top of the effective config (design doc §9.1).
 * Supports `--port <n>`, `--no-open`, and `--stop`. Returns an `error` string
 * when an argument is malformed; otherwise `error` is undefined.
 */
export function parseDashboardArgs(
  args: readonly string[],
  config: DashboardOptions,
): { options: DashboardOptions; stop: boolean; error?: string } {
  let port = config.port;
  let autoOpen = config.autoOpen;
  let stop = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--stop') {
      stop = true;
    } else if (arg === '--no-open') {
      autoOpen = false;
    } else if (arg === '--port') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return {
          options: { ...config, port, autoOpen },
          stop,
          error: '--port requires a value, e.g. --port 4000',
        };
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return {
          options: { ...config, port, autoOpen },
          stop,
          error: `Invalid port: "${raw}"`,
        };
      }
      port = parsed;
      i += 1;
    } else {
      return {
        options: { ...config, port, autoOpen },
        stop,
        error: `Unknown option: "${arg}"`,
      };
    }
  }

  return { options: { ...config, port, autoOpen }, stop };
}

function fromConfig(config: ReturnType<typeof loadConfig>): DashboardOptions {
  return {
    host: config.dashboard.host,
    port: config.dashboard.port,
    autoOpen: config.dashboard.autoOpen,
    autoOpenNonInteractive: config.dashboard.autoOpenNonInteractive,
    enabled: config.dashboard.enabled,
  };
}

/**
 * Resolve effective dashboard settings from config + CLI flags and start/stop
 * the dashboard. The server binding (Task 49) is not wired yet, so the start
 * path reports the resolved settings; `--stop` is a no-op until the instance
 * registry lands.
 */
export function runDashboard(args: readonly string[], deps: DashboardDeps = {}): number {
  const load = deps.load ?? loadConfig;
  const log = deps.log ?? ((line: string) => console.log(line));

  let config;
  try {
    config = load();
  } catch (err) {
    log(`[cadet-brainstem] dashboard: ${(err as Error).message}`);
    return 1;
  }

  const base = fromConfig(config);
  const { options, stop, error } = parseDashboardArgs(args, base);
  if (error !== undefined) {
    log(`[cadet-brainstem] dashboard: ${error}`);
    return 1;
  }

  if (stop) {
    // Task 49 wires the instance registry; nothing is running yet.
    log(
      '[cadet-brainstem] dashboard: no running instance to stop (server not wired yet — Task 49).',
    );
    return 0;
  }

  if (!options.enabled) {
    log('[cadet-brainstem] dashboard: disabled by config (dashboard.enabled=false).');
    return 0;
  }

  // Server binding lands in Task 49. Report the resolved settings so the CLI
  // interface is real and testable ahead of the server.
  log(
    `[cadet-brainstem] dashboard: not yet wired (Task 49). Would serve on http://${options.host}:${options.port}`,
  );
  log(`  auto-open: ${options.autoOpen}`);
  return 0;
}

export const dashboardCommand: CliCommand = {
  name: 'dashboard',
  description: 'Open the local metrics dashboard',
  usage: 'cadet-brainstem dashboard [--no-open] [--port <port>] [--stop]',
  run(args: readonly string[]): number {
    return runDashboard(args);
  },
};
