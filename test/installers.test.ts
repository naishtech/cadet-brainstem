import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createFastClassifierCli } from '../src/core/installers';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

type ExecFileCb = (
  err: NodeJS.ErrnoException | null,
  stdout?: string,
  stderr?: string,
) => void;

const execFileMock = vi.mocked(execFile);

function mockFetch(routes: {
  tags?: { models: Array<{ name: string }> };
  chat?: string;
}): void {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        json: async () => ({ models: routes.tags?.models ?? [] }),
      };
    }
    if (url.endsWith('/api/chat')) {
      return { ok: true, json: async () => ({ message: { content: routes.chat ?? '' } }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  execFileMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFastClassifierCli', () => {
  it('builds via the ollama CLI and returns ok when the SYSTEM is verified', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCb;
      if (args[0] === 'ollama') {
        cb(null, '', '');
      } else {
        cb(new Error('unexpected bin'), '', '');
      }
      return undefined as never;
    });
    mockFetch({
      tags: { models: [{ name: 'fast-classifier:latest' }] },
      chat: '{"task": "review", "response_policy": {"directives": []}}',
    });
    await expect(createFastClassifierCli('qwen3:1.7b', 'http://localhost:11434')).resolves.toEqual({
      ok: true,
    });
  }, 10_000);

  it('refuses a build whose SYSTEM was not baked (no classifier output)', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCb;
      if (args[0] === 'ollama') {
        cb(null, '', '');
      } else {
        cb(new Error('unexpected bin'), '', '');
      }
      return undefined as never;
    });
    // Model is present, but the probe returns a literal (non-classifier) answer.
    mockFetch({
      tags: { models: [{ name: 'fast-classifier:latest' }] },
      chat: 'You cannot merge an open PR directly.',
    });
    const res = await createFastClassifierCli('qwen3:1.7b', 'http://localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not bake the SYSTEM block/);
  }, 10_000);

  it('falls back to docker exec when the ollama CLI is not on PATH', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCb;
      if (args[0] === 'ollama') {
        const e = new Error('spawn ollama ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        cb(e, '', '');
      } else if (args[0] === 'docker') {
        cb(null, '', '');
      } else {
        cb(new Error('unexpected bin'), '', '');
      }
      return undefined as never;
    });
    mockFetch({
      tags: { models: [{ name: 'fast-classifier:latest' }] },
      chat: '{"task": "review"}',
    });
    await expect(createFastClassifierCli('qwen3:1.7b', 'http://localhost:11434')).resolves.toEqual({
      ok: true,
    });
    const dockerCalls = execFileMock.mock.calls.filter(([b]) => b === 'docker');
    expect(dockerCalls.length).toBeGreaterThan(0);
  }, 10_000);
});
