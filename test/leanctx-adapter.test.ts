import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeanCtxAdapter, resolveCliMode } from '../src/integrations/leanctx/index';
import type { LeanCtxOptimizeRequest } from '../src/integrations/leanctx/index';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const SOURCE = 'const a = 1;\nconst b = 2;\nconst total = a + b;\nconsole.log(total);\n';

const tempDirs: string[] = [];

function makeTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-leanctx-'));
  tempDirs.push(dir);
  const file = join(dir, 'sample.ts');
  writeFileSync(file, SOURCE, 'utf8');
  return file;
}

function succeedWith(stdout: string): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args.pop() as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    cb(null, { stdout, stderr: '' });
  });
}

function failWith(err: Error): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cb = args.pop() as (err: Error | null) => void;
    cb(err);
  });
}

function requestFor(overrides: Partial<LeanCtxOptimizeRequest>): LeanCtxOptimizeRequest {
  return {
    target: makeTarget(),
    mode: 'map',
    taskType: 'debug',
    ...overrides,
  };
}

afterEach(() => {
  execFileMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCliMode', () => {
  it('maps design modes to CLI modes', () => {
    expect(resolveCliMode(requestFor({ mode: 'map' }))).toBe('map');
    expect(resolveCliMode(requestFor({ mode: 'density' }))).toBe('aggressive');
    expect(resolveCliMode(requestFor({ mode: 'cognitive' }))).toBe('entropy');
    expect(resolveCliMode(requestFor({ mode: 'raw' }))).toBe('full');
    expect(resolveCliMode(requestFor({ mode: 'signatures' }))).toBe('signatures');
  });

  it('appends the range for the lines mode', () => {
    expect(resolveCliMode(requestFor({ mode: 'lines', lines: '10-50' }))).toBe('lines:10-50');
  });
});

describe('LeanCtxAdapter', () => {
  let adapter: LeanCtxAdapter;

  beforeEach(() => {
    adapter = new LeanCtxAdapter();
  });

  it('is available when lean-ctx responds', async () => {
    succeedWith('lean-ctx 3.9.19\n');
    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it('is unavailable when lean-ctx is missing', async () => {
    failWith(new Error('spawn lean-ctx ENOENT'));
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('returns compact context and records metrics', async () => {
    const compact = 'sample.ts [3L]\n  exports: total\n';
    succeedWith(compact);
    const request = requestFor({ mode: 'signatures' });
    const result = await adapter.optimize(request);

    expect(result.degraded).toBe(false);
    expect(result.context).toBe(compact);
    expect(result.mode).toBe('signatures');
    expect(result.sourceSize).toBe(Buffer.byteLength(SOURCE));
    expect(result.returnedSize).toBe(Buffer.byteLength(compact));
    expect(result.estimatedTokensSaved).toBeGreaterThan(0);
    expect(result.taskType).toBe('debug');

    // Invoked with the correct command + mapped mode.
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['read', request.target, '-m', 'signatures']);
  });

  it('maps the policy mode when invoking lean-ctx', async () => {
    succeedWith('compact');
    await adapter.optimize(requestFor({ mode: 'density' }));
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args[args.length - 1]).toBe('aggressive');
  });

  it('falls back gracefully (no data loss) when lean-ctx errors', async () => {
    failWith(new Error('read failed'));
    const request = requestFor({ mode: 'map' });
    const result = await adapter.optimize(request);

    expect(result.degraded).toBe(true);
    expect(result.context).toBe(SOURCE); // full source preserved
    expect(result.returnedSize).toBe(result.sourceSize);
    expect(result.estimatedTokensSaved).toBe(0);
  });
});
