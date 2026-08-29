import { existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { closeSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SOURCE_DIR = 'C:\\Users\\User\\AppData\\Roaming\\Code\\User\\workspaceStorage';

export interface JsonlFile {
  workspace: string;
  path: string;
  creationDate: string | null;
}

export interface InventoryReport {
  sourceDir: string;
  workspaceCount: number;
  jsonlCount: number;
  conversations: JsonlFile[];
  dateRange: { earliest: string | null; latest: string | null };
}

/** Extract the creation date from a JSONL file's kind:0 record (best-effort). */
export function readJsonlCreationDate(filePath: string): string | null {
  let fd: number | undefined;
  try {
    // Read only the first chunk (the kind:0 record is always the first line) —
    // avoids reading the whole file into memory for every session.
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
    if (first.trim().length === 0) {
      return null;
    }
    const record = JSON.parse(first) as Record<string, unknown>;
    if (record.kind !== 0) {
      return null;
    }
    const v = record.v as Record<string, unknown> | undefined;
    if (v && typeof v.creationDate === 'number') {
      return new Date(v.creationDate).toISOString();
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Step 1.1 — inventory the source data. Read-only; reports format + counts
 * without extracting anything. The caller must stop for review after this.
 */
export function inventorySource(sourceDir: string = DEFAULT_SOURCE_DIR): InventoryReport {
  const conversations: JsonlFile[] = [];
  let workspaceCount = 0;

  if (!existsSync(sourceDir)) {
    return { sourceDir, workspaceCount: 0, jsonlCount: 0, conversations: [], dateRange: { earliest: null, latest: null } };
  }

  const workspaces = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of workspaces) {
    if (!entry.isDirectory()) {
      continue;
    }
    const chatDir = join(sourceDir, entry.name, 'chatSessions');
    if (!existsSync(chatDir) || !statSync(chatDir).isDirectory()) {
      continue;
    }
    workspaceCount += 1;
    for (const file of readdirSync(chatDir)) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      conversations.push({
        workspace: entry.name,
        path: join(chatDir, file),
        creationDate: readJsonlCreationDate(join(chatDir, file)),
      });
    }
  }

  const dates = conversations
    .map((c) => c.creationDate)
    .filter((d): d is string => d !== null)
    .sort();
  const earliest = dates.length > 0 ? (dates[0] ?? null) : null;
  const latest = dates.length > 0 ? (dates[dates.length - 1] ?? null) : null;

  return {
    sourceDir,
    workspaceCount,
    jsonlCount: conversations.length,
    conversations,
    dateRange: { earliest, latest },
  };
}
