import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

/** Stable PID file so `dashboard --stop` can signal a running instance. */
export function getDashboardPidPath(): string {
  return join(os.homedir(), '.cadet-brainstem', 'dashboard.pid');
}

export function writePidFile(path = getDashboardPidPath()): void {
  writeFileSync(path, String(process.pid), 'utf8');
}

export function removePidFile(path = getDashboardPidPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Read the registered PID, or undefined when absent/invalid. */
export function readPidFile(path = getDashboardPidPath()): number | undefined {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StopResult {
  stopped: boolean;
  message: string;
}

/**
 * Stop the dashboard instance registered in the PID file (used by
 * `dashboard --stop`). Terminates the process with SIGTERM and clears the file.
 */
export function stopByPidFile(path = getDashboardPidPath()): StopResult {
  const pid = readPidFile(path);
  if (pid === undefined) {
    return { stopped: false, message: 'no dashboard instance registered' };
  }
  if (!isProcessAlive(pid)) {
    removePidFile(path);
    return { stopped: false, message: `dashboard instance (pid ${pid}) is not running` };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return { stopped: false, message: `could not stop dashboard instance (pid ${pid})` };
  }
  removePidFile(path);
  return { stopped: true, message: `stopped dashboard instance (pid ${pid})` };
}
