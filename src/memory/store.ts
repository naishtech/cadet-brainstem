import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** A single persisted memory (design doc §17). */
export interface Memory {
  id: string;
  content: string;
  tags: string[];
  project: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  hits: number;
}

export interface StoreInput {
  content: string;
  tags?: string[];
  project?: string;
}

export interface UpdateInput {
  content?: string;
  tags?: string[];
}

export interface SearchInput {
  query?: string;
  tags?: string[];
  project?: string;
}

export interface ListInput {
  project?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tags TEXT,
  project TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  hits INTEGER NOT NULL DEFAULT 0
);
`;

const MEMORY_COLUMNS =
  'id, content, tags, project, created_at, updated_at, last_accessed_at, hits';

export const DEFAULT_MEMORY_DIR = '.cadet-token-saver';

/**
 * Stable local path for the memory database.
 * Overridable via CADET_TOKEN_SAVER_MEMORY (useful for tests / non-default setups).
 */
export function getDefaultMemoryPath(): string {
  const env = process.env.CADET_TOKEN_SAVER_MEMORY;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return join(os.homedir(), DEFAULT_MEMORY_DIR, 'memory.db');
}

/** Parse the JSON-encoded tags column back into a string array (never throws). */
function parseTags(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String);
  }
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Local SQLite memory store (design doc §17).
 *
 * Works completely offline. Persists agent memories — facts that are expensive
 * to rediscover. By design this module validates/normalises content shape but
 * cannot police what is stored: never store secrets or credentials (safety
 * principle §14); steering covers the policy.
 */
export class MemoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = getDefaultMemoryPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Add columns introduced after the first schema version to DBs created before
   * them, so existing memory files upgrade in place (no manual clear needed).
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(memories)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      // Future column additions go here, e.g.
      // ['summary', 'ALTER TABLE memories ADD COLUMN summary TEXT'],
    ];
    for (const [column, ddl] of additions) {
      if (!columns.has(column)) {
        this.db.exec(ddl);
      }
    }
  }

  /** Persist a new memory and return its generated id. */
  store(input: StoreInput): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memories (id, content, tags, project, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.content,
        input.tags === undefined ? null : JSON.stringify(input.tags),
        input.project ?? null,
        now,
        now,
      );
    return id;
  }

  /**
   * Update content and/or tags. Returns whether the memory existed.
   * Only the provided fields change; `updated_at` is refreshed.
   */
  update(id: string, input: UpdateInput = {}): boolean {
    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (input.content !== undefined) {
      sets.push('content = ?');
      params.push(input.content);
    }
    if (input.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (sets.length === 0) {
      return this.db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id) !== undefined;
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    const result = this.db
      .prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  /** Fetch a memory by id, bumping its hit counter and last-accessed timestamp. */
  get(id: string): Memory | null {
    this.db
      .prepare('UPDATE memories SET last_accessed_at = ?, hits = hits + 1 WHERE id = ?')
      .run(new Date().toISOString(), id);
    const row = this.db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  /**
   * Search memories by content substring, optionally scoped by project and/or
   * tags (a memory must contain ALL requested tags to match).
   */
  search(input: SearchInput = {}): Memory[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.query !== undefined && input.query.length > 0) {
      clauses.push('content LIKE ?');
      params.push(`%${input.query}%`);
    }
    if (input.project !== undefined) {
      clauses.push('project = ?');
      params.push(input.project);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    const memories = rows.map((row) => this.mapRow(row));
    if (input.tags === undefined || input.tags.length === 0) {
      return memories;
    }
    return memories.filter((memory) =>
      input.tags!.every((tag) => memory.tags.includes(tag)),
    );
  }

  /** List memories (most recently updated first), optionally scoped by project. */
  list(input: ListInput = {}): Memory[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.project !== undefined) {
      clauses.push('project = ?');
      params.push(input.project);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT ${MEMORY_COLUMNS} FROM memories ${where} ORDER BY updated_at DESC`;
    if (input.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(input.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row));
  }

  /** Delete a memory by id. Returns whether it was removed. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Total number of memories, optionally scoped to a project. */
  count(project?: string): number {
    const row =
      project === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as {
            c: number;
          })
        : (this.db
            .prepare('SELECT COUNT(*) AS c FROM memories WHERE project = ?')
            .get(project) as { c: number });
    return Number(row.c);
  }

  close(): void {
    this.db.close();
  }

  /** Delete memories, optionally scoped to a project; returns rows removed. */
  clear(project?: string): number {
    const result =
      project === undefined
        ? this.db.prepare('DELETE FROM memories').run()
        : this.db.prepare('DELETE FROM memories WHERE project = ?').run(project);
    return Number(result.changes);
  }

  private mapRow(row: Record<string, unknown>): Memory {
    return {
      id: String(row.id),
      content: String(row.content),
      tags: parseTags(row.tags),
      project: row.project === null || row.project === undefined ? null : String(row.project),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastAccessedAt:
        row.last_accessed_at === null || row.last_accessed_at === undefined
          ? null
          : String(row.last_accessed_at),
      hits: Number(row.hits),
    };
  }
}
