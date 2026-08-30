import http, { type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../package.json';
import { getDefaultMetricsPath, MetricsStore, formatStats } from '../metrics';
import { Router, sendJson } from './router';
import { openSse, type SseConnection } from './stream';
import { getEventBus, type DashboardEvent, type EventBus } from './event-bus';
import { getServiceStatus, type ToolStatus } from './status';

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 4100;
/** Bounded range to auto-increment through when the requested port is busy. */
export const PORT_RANGE = 20;
/** Heartbeat cadence for SSE connections (design §5.4). */
export const SSE_HEARTBEAT_MS = 15_000;
/** Default status re-check interval in seconds (design §5.5). */
export const DEFAULT_STATUS_INTERVAL_SEC = 30;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface DashboardServerOptions {
  /** Bind host; defaults to 127.0.0.1 (never 0.0.0.0 unless set explicitly). */
  host?: string;
  /** Requested port; defaults to 4100 and auto-increments if busy. */
  port?: number;
  /** Directory of built Vue static assets. Defaults to dist/dashboard/static. */
  staticDir?: string;
  /** Metrics database path for /api/stats. Defaults to the standard path. */
  metricsPath?: string;
  /** Status re-check interval in seconds. Defaults to 30. */
  statusIntervalSec?: number;
  /** EventBus to subscribe for SSE broadcasts. Defaults to the singleton. */
  eventBus?: EventBus;
  /** Status resolver for /api/status. Defaults to getServiceStatus(). */
  getStatus?: () => Promise<ToolStatus[]>;
  /** Optional log sink. */
  log?: (line: string) => void;
}

export interface ServerInfo {
  host: string;
  port: number;
  url: string;
}

/**
 * Local dashboard HTTP/SSE server (design doc §5.1, §5.4). Serves the built
 * Vue static assets and a small REST/SSE API. Binds to localhost only.
 */
export class DashboardServer {
  private readonly options: DashboardServerOptions;
  private readonly router = new Router();
  private readonly eventBus: EventBus;
  private server: HttpServer | undefined;
  private info: ServerInfo | undefined;
  private readonly sseConnections = new Set<SseConnection>();
  private heartbeat: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(options: DashboardServerOptions = {}) {
    this.options = options;
    this.eventBus = options.eventBus ?? getEventBus();
    this.registerRoutes();
  }

  isRunning(): boolean {
    return this.server !== undefined && this.server.listening;
  }

  getInfo(): ServerInfo | undefined {
    return this.info;
  }

  /** Start (or no-op if already running). Resolves with server info. */
  async start(): Promise<ServerInfo> {
    if (this.isRunning() && this.info !== undefined) return this.info;

    const host = this.options.host ?? DEFAULT_DASHBOARD_HOST;
    const basePort = this.options.port ?? DEFAULT_DASHBOARD_PORT;
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    let bound: number | undefined;
    for (let attempt = 0; attempt <= PORT_RANGE; attempt += 1) {
      const candidate = basePort + attempt;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException): void => reject(err);
          server.once('error', onError);
          server.listen(candidate, host, () => {
            server.removeListener('error', onError);
            resolve();
          });
        });
        bound = candidate;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw err;
      }
    }

    if (bound === undefined) {
      throw new Error(
        `dashboard: ports ${basePort}-${basePort + PORT_RANGE} are all in use`,
      );
    }

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : bound;

    this.server = server;
    this.info = { host, port, url: `http://${host}:${port}` };
    this.startHeartbeat();
    this.startStatusRefresh();
    return this.info;
  }

  /** Stop the server and close all SSE connections. Idempotent. */
  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.stopStatusRefresh();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const conn of this.sseConnections) {
      conn.close();
    }
    this.sseConnections.clear();

    const server = this.server;
    this.server = undefined;
    this.info = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  private registerRoutes(): void {
    this.router.get('/api/health', (_req, res) => {
      sendJson(res, 200, { ok: true, version: pkg.version });
    });

    this.router.get('/api/stats', (_req, res) => {
      let store: MetricsStore;
      try {
        store = new MetricsStore(this.options.metricsPath ?? getDefaultMetricsPath());
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
        return;
      }
      try {
        sendJson(res, 200, formatStats(store));
      } finally {
        store.close();
      }
    });

    this.router.get('/api/status', async (_req, res) => {
      try {
        const services = await this.refreshStatus();
        sendJson(res, 200, services);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    });

    // Placeholder; wired by Task 52.
    this.router.get('/api/logs', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
      const sinceRaw = url.searchParams.get('since');
      const since = sinceRaw !== null && sinceRaw.length > 0 ? Number(sinceRaw) : undefined;
      sendJson(res, 200, { events: this.eventBus.recent(limit, since) });
    });

    this.router.get('/api/events', (req, res) => {
      this.handleSse(req, res);
    });
  }

  private handleSse(_req: IncomingMessage, res: ServerResponse): void {
    const conn = openSse(res);
    this.sseConnections.add(conn);
    // Drop the connection from the set once the client disconnects.
    res.on('close', () => {
      this.sseConnections.delete(conn);
    });
    // Replay recent buffered events, then live events flow via the broadcast.
    for (const event of this.eventBus.recent(100)) {
      const { type, ...data } = event;
      conn.write(type, data);
    }
    // Initial comment so the client sees the stream open immediately.
    conn.comment('connected');
  }

  /** Re-check service status, publish on the EventBus, and return it. */
  private async refreshStatus(): Promise<ToolStatus[]> {
    const getStatus = this.options.getStatus ?? getServiceStatus;
    const services = await getStatus();
    this.eventBus.status(services);
    return services;
  }

  /** Broadcast an EventBus event to all SSE subscribers as a named frame. */
  private broadcastEvent(event: DashboardEvent): void {
    const { type, ...data } = event;
    for (const conn of this.sseConnections) {
      conn.write(type, data);
    }
  }

  private startStatusRefresh(): void {
    const intervalSec = this.options.statusIntervalSec ?? DEFAULT_STATUS_INTERVAL_SEC;
    this.statusTimer = setInterval(() => {
      void this.refreshStatus().catch(() => undefined);
    }, intervalSec * 1000);
    this.statusTimer.unref?.();
    // Subscribe the SSE broadcast to the EventBus, then do an initial check.
    this.unsubscribe = this.eventBus.subscribe((event) => this.broadcastEvent(event));
    void this.refreshStatus().catch(() => undefined);
  }

  private stopStatusRefresh(): void {
    if (this.statusTimer !== undefined) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      for (const conn of this.sseConnections) {
        conn.comment('heartbeat');
      }
    }, SSE_HEARTBEAT_MS);
    // Don't keep the process alive solely for the heartbeat.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const handled = await this.router.handle(req, res);
    if (handled) return;

    if (req.url?.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    this.serveStatic(req, res);
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const staticDir = this.options.staticDir ?? DEFAULT_STATIC_DIR;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

    const candidate = join(staticDir, relative);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      this.sendFile(candidate, res);
      return;
    }

    // SPA fallback: serve index.html for non-file routes.
    const index = join(staticDir, 'index.html');
    if (existsSync(index)) {
      this.sendFile(index, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  private sendFile(path: string, res: ServerResponse): void {
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    createReadStream(path).pipe(res);
  }
}

const DEFAULT_STATIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'dashboard',
  'static',
);
