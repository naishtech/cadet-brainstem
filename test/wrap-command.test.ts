import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseWrapArgs,
  runWrap,
  wrapCommand,
  type WrapDeps,
} from '../src/cli/commands/wrap';
import type { RtkResult } from '../src/integrations/rtk';
import { MetricsStore } from '../src/metrics';

function makeFakeResult(overrides: Partial<RtkResult> = {}): RtkResult {
  return {
    command: 'git status',
    rawOutput: 'RAW\nLINE\n',
    optimisedOutput: 'REDUCED\n',
    rawOutputSize: 100,
    optimisedOutputSize: 25,
    estimatedTokensBefore: 25,
    estimatedTokensAfter: 6,
    estimatedTokensSaved: 19,
    timestamp: '2026-08-26T00:00:00.000Z',
    degraded: false,
    ...overrides,
  };
}

let dir: string;
let metricsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-wrap-'));
  metricsPath = join(dir, 'metrics.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function savedRtkTokens(path: string): number {
  const store = new MetricsStore(path);
  const totals = store.getTotals();
  store.close();
  return totals.estimatedTokensSaved;
}

describe('parseWrapArgs', () => {
  it('treats everything after -- as the command', () => {
    expect(parseWrapArgs(['--', 'git', 'status'])).toEqual({
      command: 'git status',
      raw: false,
    });
  });

  it('keeps command flags without a separator', () => {
    expect(parseWrapArgs(['git', 'status', '--short'])).toEqual({
      command: 'git status --short',
      raw: false,
    });
  });

  it('parses --raw before the separator', () => {
    expect(parseWrapArgs(['--raw', '--', 'git', 'status'])).toEqual({
      command: 'git status',
      raw: true,
    });
    expect(parseWrapArgs(['-r', 'git', 'status'])).toEqual({
      command: 'git status',
      raw: true,
    });
  });

  it('returns no command when nothing is provided', () => {
    expect(parseWrapArgs([])).toEqual({ command: undefined, raw: false });
  });

  it('parses --shell before the separator', () => {
    expect(parseWrapArgs(['--shell', 'bash', '--', 'git', 'status'])).toEqual({
      command: 'git status',
      raw: false,
      shell: 'bash',
    });
  });
});

describe('runWrap', () => {
  function makeDeps(overrides: Partial<WrapDeps> = {}): {
    deps: WrapDeps;
    lines: string[];
  } {
    const lines: string[] = [];
    const rtk = {
      optimize: vi.fn(async (req: { command: string }) =>
        makeFakeResult({ command: req.command }),
      ),
    };
    return {
      deps: { rtk, metricsPath, log: (line) => lines.push(line), ...overrides },
      lines,
    };
  }

  it('prints the reduced output by default and records rtk savings', async () => {
    const { deps, lines } = makeDeps();
    const exit = await runWrap('git status', {}, deps);

    expect(exit).toBe(0);
    expect(lines).toEqual(['REDUCED\n']);
    expect(savedRtkTokens(metricsPath)).toBe(19);
  });

  it('prints the raw output with --raw', async () => {
    const { deps, lines } = makeDeps();
    await runWrap('git status', { raw: true }, deps);

    expect(lines).toEqual(['RAW\nLINE\n']);
  });

  it('falls back to the original output when degraded', async () => {
    const { deps, lines } = makeDeps();
    const degradedRtk = {
      optimize: vi.fn(async () =>
        makeFakeResult({ degraded: true, optimisedOutput: 'RAW\nLINE\n' }),
      ),
    };
    await runWrap('git status', {}, { ...deps, rtk: degradedRtk });

    expect(lines).toEqual(['RAW\nLINE\n']);
  });

  it('records a metrics row even when degraded (saved 0)', async () => {
    const { deps } = makeDeps();
    const degradedRtk = {
      optimize: vi.fn(async () =>
        makeFakeResult({ degraded: true, estimatedTokensSaved: 0 }),
      ),
    };
    await runWrap('git status', {}, { ...deps, rtk: degradedRtk });

    expect(savedRtkTokens(metricsPath)).toBe(0);
  });

  it('forwards a shell and notes on stderr when nothing is compressed', async () => {
    const { deps, lines } = makeDeps();
    const rtk = {
      optimize: vi.fn(async (req: { command: string }) =>
        makeFakeResult({ command: req.command, estimatedTokensSaved: 0 }),
      ),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runWrap('git status', { shell: 'bash' }, { ...deps, rtk });
      expect(rtk.optimize).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'git status', shell: 'bash' }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('nothing to compress'),
      );
      expect(lines).toEqual(['REDUCED\n']);
    } finally {
      error.mockRestore();
    }
  });
});

describe('wrapCommand', () => {
  it('exits 1 with a usage message when no command is given', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const exit = await wrapCommand.run([], { cwd: process.cwd() });
      expect(exit).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('wrap: missing command'),
      );
    } finally {
      error.mockRestore();
    }
  });
});
