import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config';
import { startInProcessDashboard } from '../src/dashboard/auto-start';
import type { DashboardServer } from '../src/dashboard/server';
import type { DashboardLaunchConfig } from '../src/dashboard/auto-start';

function stubServer(info = { host: '127.0.0.1', port: 4100, url: 'http://127.0.0.1:4100' }) {
  return {
    start: vi.fn(async () => info),
    stop: vi.fn(async () => undefined),
    isRunning: vi.fn(() => true),
    getInfo: vi.fn(() => info),
  } as unknown as DashboardServer;
}

function cfg(overrides: Partial<typeof defaultConfig.dashboard> = {}) {
  return {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, ...overrides },
  };
}

describe('startInProcessDashboard', () => {
  it('starts the server and opens the browser when interactive and autoOpen', async () => {
    const server = stubServer();
    const open = vi.fn(async () => true);
    const result = await startInProcessDashboard({
      load: () => cfg({ enabled: true, autoOpen: true }),
      open,
      isNonInteractive: () => false,
      createServer: () => server,
    });

    expect(result).toBeDefined();
    expect(result!.info.url).toBe('http://127.0.0.1:4100');
    expect(server.start).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:4100');
  });

  it('does not open the browser when non-interactive', async () => {
    const server = stubServer();
    const open = vi.fn(async () => true);
    await startInProcessDashboard({
      load: () => cfg({ enabled: true, autoOpen: true }),
      open,
      isNonInteractive: () => true,
      createServer: () => server,
    });

    expect(server.start).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('returns undefined and does not start when disabled', async () => {
    const server = stubServer();
    const result = await startInProcessDashboard({
      load: () => cfg({ enabled: false }),
      createServer: () => server,
    });

    expect(result).toBeUndefined();
    expect(server.start).not.toHaveBeenCalled();
  });

  it('passes the configured host/port/interval to the server factory', async () => {
    let captured: DashboardLaunchConfig | undefined;
    const server = stubServer();
    await startInProcessDashboard({
      load: () => cfg({ host: '0.0.0.0', port: 4200, statusIntervalSec: 15 }),
      isNonInteractive: () => true,
      createServer: (launch) => {
        captured = launch;
        return server;
      },
    });

    expect(captured).toEqual({ host: '0.0.0.0', port: 4200, statusIntervalSec: 15 });
  });

  it('returns undefined when start fails (never throws)', async () => {
    const server = stubServer();
    server.start = vi.fn(async () => {
      throw new Error('port in use');
    }) as never;
    const result = await startInProcessDashboard({
      load: () => cfg({ enabled: true }),
      createServer: () => server,
    });

    expect(result).toBeUndefined();
  });
});
