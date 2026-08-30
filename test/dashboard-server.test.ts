import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardServer } from '../src/dashboard/server';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-srv-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
      );
    });
    req.on('error', reject);
  });
}

/** Connect to /api/events; resolves once the server's initial comment arrives. */
function openSseClient(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.includes('connected')) resolve(body);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

describe('DashboardServer', () => {
  it('serves /api/health', async () => {
    const server = new DashboardServer({ port: 0 });
    const info = await server.start();
    const res = await get(info.port, '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    await server.stop();
  });

  it('serves static index.html and assets with SPA fallback', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), '<html>dashboard</html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1);');

    const server = new DashboardServer({ port: 0, staticDir: dir });
    const info = await server.start();

    const index = await get(info.port, '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('dashboard');
    expect(index.headers['content-type']).toContain('text/html');

    const js = await get(info.port, '/app.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');

    const fallback = await get(info.port, '/some/route');
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain('dashboard');

    await server.stop();
  });

  it('returns 404 for unknown /api routes', async () => {
    const server = new DashboardServer({ port: 0 });
    const info = await server.start();
    const res = await get(info.port, '/api/nope');
    expect(res.status).toBe(404);
    await server.stop();
  });

  it('returns 501 for not-yet-wired api routes', async () => {
    const server = new DashboardServer({ port: 0 });
    const info = await server.start();
    const res = await get(info.port, '/api/stats');
    expect(res.status).toBe(501);
    await server.stop();
  });

  it('auto-increments the port when the requested one is busy', async () => {
    const first = new DashboardServer({ port: 0 });
    const info1 = await first.start();

    const second = new DashboardServer({ port: info1.port });
    const info2 = await second.start();
    expect(info2.port).toBe(info1.port + 1);

    await first.stop();
    await second.stop();
  });

  it('start is idempotent and stop is clean', async () => {
    const server = new DashboardServer({ port: 0 });
    const info = await server.start();
    expect(server.isRunning()).toBe(true);

    const again = await server.start();
    expect(again).toEqual(info);

    await server.stop();
    expect(server.isRunning()).toBe(false);
    await server.stop(); // second stop is a no-op
  });

  it('SSE supports multiple subscribers', async () => {
    const server = new DashboardServer({ port: 0 });
    const info = await server.start();

    const [a, b] = await Promise.all([
      openSseClient(info.port),
      openSseClient(info.port),
    ]);
    expect(a).toContain('connected');
    expect(b).toContain('connected');

    await server.stop();
  });
});
