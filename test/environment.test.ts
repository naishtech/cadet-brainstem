import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectEnvironment, detectPlatform } from '../src/core/environment';

const { execFileMock, execMock, fetchMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  exec: execMock,
}));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  execFileMock.mockReset();
  execMock.mockReset();
  fetchMock.mockReset();
});

/** execFile/exec mock that resolves the callback with stdout for any bin. */
function resolveWith(stdout: string): void {
  const impl = (...args: unknown[]) => {
    const cb = args.pop() as (
      err: Error | null,
      result: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout, stderr: '' });
  };
  execFileMock.mockImplementation(impl);
  execMock.mockImplementation(impl);
}

/** execFile/exec mock that fails like ENOENT for any bin. */
function failLikeEnoent(): void {
  const impl = (...args: unknown[]) => {
    const cb = args.pop() as (err: Error) => void;
    cb(new Error('ENOENT'));
  };
  execFileMock.mockImplementation(impl);
  execMock.mockImplementation(impl);
}

describe('detectPlatform', () => {
  it('returns a known platform string', () => {
    expect(['windows', 'macos', 'linux', 'unknown']).toContain(detectPlatform());
  });
});

describe('detectEnvironment', () => {
  it('reports everything available when tools respond', async () => {
    resolveWith('0.45.0\n');
    fetchMock.mockResolvedValue({ ok: true } as Response);

    const report = await detectEnvironment();

    expect(report.node.available).toBe(true);
    expect(report.npm.available).toBe(true);
    expect(report.ollama.available).toBe(true);
    expect(report.rtk.available).toBe(true);
    expect(report.serena.available).toBe(true);
    expect(report.leanctx.available).toBe(true);
    expect(report.missingTools).toEqual([]);
    expect(report.availableTools.sort()).toEqual(['leanctx', 'rtk', 'serena']);
    expect(report.rtk.detail).toContain('0.45.0');
    expect(report.ollama.detail).toContain('http');
  });

  it('reports missing tools when nothing responds', async () => {
    failLikeEnoent();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const report = await detectEnvironment();

    expect(report.ollama.available).toBe(false);
    expect(report.rtk.available).toBe(false);
    expect(report.serena.available).toBe(false);
    expect(report.leanctx.available).toBe(false);
    expect(report.availableTools).toEqual([]);
    expect(report.missingTools.sort()).toEqual(['leanctx', 'rtk', 'serena']);
  });

  it('does not throw when ollama is unreachable but tools exist', async () => {
    resolveWith('1.7.0\n');
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(detectEnvironment()).resolves.toMatchObject({
      ollama: { available: false },
      rtk: { available: true },
    });
  });
});
