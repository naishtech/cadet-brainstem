import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

/**
 * Minimal method + path router for the dashboard REST/SSE API
 * (design doc §5.2). Path params use `:name` segments.
 */
export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }

  add(method: string, path: string, handler: RouteHandler): void {
    const keys: string[] = [];
    const pattern = path.replace(/:([^/]+)/g, (_m, name: string) => {
      keys.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${pattern}$`), keys, handler });
  }

  /**
   * Try to dispatch `req`. Returns true when a route matched and handled it.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = url.pathname.match(route.pattern);
      if (match === null) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = match[i + 1] as string;
      });
      await route.handler(req, res, { url, params });
      return true;
    }
    return false;
  }
}

/** Write a JSON response with the given status code. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
