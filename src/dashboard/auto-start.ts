import { loadConfig } from '../config';
import { getEventBus } from './event-bus';
import { DashboardServer } from './server';
import { isNonInteractive, openBrowser } from './open-browser';

export interface DashboardLaunchConfig {
  host: string;
  port: number;
  statusIntervalSec: number;
}

export interface StartDashboardOptions {
  /** Override config loader (tests). */
  load?: typeof loadConfig;
  /** Override browser open (tests). */
  open?: typeof openBrowser;
  /** Override the interactivity check (tests). */
  isNonInteractive?: () => boolean;
  /** Override server construction (tests). */
  createServer?: (cfg: DashboardLaunchConfig) => DashboardServer;
}

export interface StartDashboardResult {
  server: DashboardServer;
  info: { host: string; port: number; url: string };
}

/**
 * Start the dashboard in-process (design doc §9.2) so live classify/MCP events
 * stream to it over the shared EventBus. Called by the MCP server on start.
 *
 * Never throws and never blocks: the dashboard is best-effort and its failure
 * must not break the MCP server. Returns undefined when disabled or on failure.
 */
export async function startInProcessDashboard(
  options: StartDashboardOptions = {},
): Promise<StartDashboardResult | undefined> {
  const load = options.load ?? loadConfig;
  const open = options.open ?? openBrowser;
  const nonInteractive = options.isNonInteractive ?? (() => isNonInteractive());
  const createServer =
    options.createServer ??
    ((cfg: DashboardLaunchConfig) =>
      new DashboardServer({
        host: cfg.host,
        port: cfg.port,
        statusIntervalSec: cfg.statusIntervalSec,
        eventBus: getEventBus(),
      }));

  let cfg;
  try {
    cfg = load();
  } catch {
    return undefined;
  }
  if (!cfg.dashboard.enabled) return undefined;

  const server = createServer({
    host: cfg.dashboard.host,
    port: cfg.dashboard.port,
    statusIntervalSec: cfg.dashboard.statusIntervalSec,
  });
  try {
    const info = await server.start();
    const skipAutoOpen = nonInteractive() || cfg.dashboard.autoOpenNonInteractive;
    if (cfg.dashboard.autoOpen && !skipAutoOpen) {
      void open(info.url).catch(() => undefined);
    }
    return { server, info };
  } catch {
    // Non-fatal: dashboard failure must never break the MCP server.
    return undefined;
  }
}
