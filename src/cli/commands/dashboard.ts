import { loadConfig } from '../../config';
import { DashboardServer } from '../../dashboard/server';
import { openBrowser, isNonInteractive } from '../../dashboard/open-browser';
import { writePidFile, stopByPidFile } from '../../dashboard/lifecycle';
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
 * the dashboard (design doc §9.1). `--stop` terminates a running instance via
 * its PID file; the start path binds the server, opens the browser when
 * interactive, and blocks until the process is terminated.
 */
export async function runDashboard(
  args: readonly string[],
  deps: DashboardDeps = {},
): Promise<number> {
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
    const { message } = stopByPidFile();
    log(`[cadet-brainstem] dashboard: ${message}`);
    return 0;
  }

  if (!options.enabled) {
    log('[cadet-brainstem] dashboard: disabled by config (dashboard.enabled=false).');
    return 0;
  }

  const server = new DashboardServer({ host: options.host, port: options.port, log });
  try {
    const info = await server.start();
    writePidFile();
    log(`[cadet-brainstem] dashboard: serving at ${info.url}`);

    if (options.autoOpen) {
      const opened = await openBrowser(info.url, {
        nonInteractive: isNonInteractive() || options.autoOpenNonInteractive,
      });
      if (!opened) {
        log('[cadet-brainstem] dashboard: browser open skipped (non-interactive).');
      }
    }
  } catch (err) {
    log(`[cadet-brainstem] dashboard: ${(err as Error).message}`);
    return 1;
  }

  // Block until the process is terminated (e.g. `dashboard --stop`).
  return new Promise<number>(() => {
    /* keeps the server alive */
  });
}

export const dashboardCommand: CliCommand = {
  name: 'dashboard',
  description: 'Open the local metrics dashboard',
  usage: 'cadet-brainstem dashboard [--no-open] [--port <port>] [--stop]',
  run(args: readonly string[]): Promise<number> {
    return runDashboard(args);
  },
};
