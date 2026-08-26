import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtkAdapter } from '../src/integrations/rtk/index';

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));

vi.mock('node:child_process', () => ({ exec: execMock }));

/**
 * Mock exec. The adapter promisifies exec; the mock must resolve with
 * `{ stdout, stderr }` (matching Node's promisified execFile/exec shape).
 */
function mockExec(handler: (cmd: string) => { stdout: string } | Error): void {
  execMock.mockImplementation((...args: unknown[]) => {
    const cmd = args[0] as string;
    const cb = args.pop() as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    const res = handler(cmd);
    if (res instanceof Error) {
      cb(res);
    } else {
      cb(null, { stdout: res.stdout, stderr: '' });
    }
  });
}

afterEach(() => {
  execMock.mockReset();
});

describe('RtkAdapter', () => {
  let adapter: RtkAdapter;

  beforeEach(() => {
    adapter = new RtkAdapter();
  });

  it('is available when rtk responds', async () => {
    mockExec(() => ({ stdout: 'rtk 0.45.0\n' }));
    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it('is unavailable when rtk is missing', async () => {
    mockExec(() => new Error("'rtk' is not recognized"));
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('returns reduced output and records all seven metrics', async () => {
    const raw = 'line1\nline2\nline3\nline4\n';
    const compact = '4 lines\n';
    mockExec((cmd) => ({ stdout: cmd.startsWith('rtk ') ? compact : raw }));

    const result = await adapter.optimize({ command: 'git status' });

    expect(result.degraded).toBe(false);
    expect(result.command).toBe('git status');
    expect(result.rawOutput).toBe(raw);
    expect(result.optimisedOutput).toBe(compact);
    expect(result.rawOutputSize).toBe(Buffer.byteLength(raw));
    expect(result.optimisedOutputSize).toBe(Buffer.byteLength(compact));
    expect(result.estimatedTokensBefore).toBe(Math.round(Buffer.byteLength(raw) / 4));
    expect(result.estimatedTokensAfter).toBe(Math.round(Buffer.byteLength(compact) / 4));
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.timestamp).toBeDefined();

    // RTK invoked as `rtk <command>`.
    const calls = execMock.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('rtk --version');
    expect(calls).toContain('rtk git status');
    expect(calls).toContain('git status');
  });

  it('forwards a custom shell to the command execution', async () => {
    mockExec((cmd) => ({ stdout: cmd.startsWith('rtk ') ? 'compact\n' : 'raw\n' }));

    const result = await adapter.optimize({
      command: 'grep -r foo',
      shell: 'bash',
    });

    expect(result.degraded).toBe(false);
    const shells = execMock.mock.calls
      .map((c) => {
        const options = c[1] as { shell?: string } | undefined;
        return options?.shell;
      })
      .filter((s): s is string => s !== undefined);
    expect(shells).toEqual(expect.arrayContaining(['bash']));
  });

  it('falls back to the normal command path when RTK is missing', async () => {
    mockExec((cmd) =>
      cmd.startsWith('rtk ') ? new Error('not found') : { stdout: 'raw output\n' },
    );

    const result = await adapter.optimize({ command: 'ls' });

    expect(result.degraded).toBe(true);
    expect(result.rawOutput).toBe('raw output\n');
    expect(result.optimisedOutput).toBe('raw output\n');
    expect(result.estimatedTokensSaved).toBe(0);
  });

  it('falls back when the rtk run errors', async () => {
    mockExec((cmd) =>
      cmd === 'rtk --version' ? { stdout: 'rtk 0.45.0\n' } : cmd.startsWith('rtk ') ? new Error('boom') : { stdout: 'raw\n' },
    );

    const result = await adapter.optimize({ command: 'git status' });

    expect(result.degraded).toBe(true);
    expect(result.optimisedOutput).toBe('raw\n');
    expect(result.estimatedTokensSaved).toBe(0);
  });
});
