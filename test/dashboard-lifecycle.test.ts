import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPidFile,
  removePidFile,
  stopByPidFile,
  writePidFile,
} from '../src/dashboard/lifecycle';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-life-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('dashboard lifecycle pid file', () => {
  it('round-trips a pid file', () => {
    const path = join(tempDir(), 'dashboard.pid');
    writePidFile(path);
    expect(readPidFile(path)).toBe(process.pid);

    removePidFile(path);
    expect(readPidFile(path)).toBeUndefined();
  });

  it('stopByPidFile reports no instance when the file is missing', () => {
    const path = join(tempDir(), 'dashboard.pid');
    const res = stopByPidFile(path);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain('no dashboard instance');
  });

  it('stopByPidFile reports a stale pid as not running and clears it', () => {
    const path = join(tempDir(), 'dashboard.pid');
    writeFileSync(path, '999999999', 'utf8'); // extremely unlikely to be a live pid

    const res = stopByPidFile(path);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain('not running');
    expect(readPidFile(path)).toBeUndefined();
  });
});
