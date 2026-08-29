import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * Stable local path for the mining database.
 *
 * Separate from the memory service's `memory.db` — mining is entirely about
 * `procedures` candidates and must never touch the memory service or its data.
 * Overridable via CADET_BRAINSTEM_MINE (useful for tests / non-default setups).
 */
export function getDefaultMinePath(): string {
  const env = process.env.CADET_BRAINSTEM_MINE;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return join(os.homedir(), '.cadet-brainstem', 'mine.db');
}

export interface RawConversation {
  id: string;
  sourceWorkspace: string;
  conversationId: string;
  timestamp: string | null;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  redactions: number;
}

export interface ReviewCandidate {
  id: string;
  sourceWorkspace: string;
  sourceConversationId: string;
  timestamp: string | null;
  triggerPattern: string;
  keywords: string[];
  steps: string[];
  isProcedural: boolean;
  confidence: number;
  redactions: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS procedure_candidates_raw (
  id TEXT PRIMARY KEY,
  source_workspace TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  timestamp TEXT,
  messages TEXT NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS procedure_candidates_review (
  id TEXT PRIMARY KEY,
  source_workspace TEXT NOT NULL,
  source_conversation_id TEXT NOT NULL,
  timestamp TEXT,
  trigger_pattern TEXT NOT NULL,
  keywords TEXT NOT NULL,
  steps TEXT NOT NULL,
  is_procedural INTEGER NOT NULL,
  confidence REAL NOT NULL,
  redactions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/**
 * Local SQLite store for procedure-mining candidates (task 45).
 *
 * Deliberately separate from the memory service. Stage-only: nothing here is
 * the live `procedures` table — candidates await human review before any
 * promotion (Phase 2 / task 46).
 */
export class MineStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = getDefaultMinePath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Save a normalized raw conversation (Step 1.2). Returns its id. */
  saveRaw(input: Omit<RawConversation, 'id'>): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO procedure_candidates_raw
           (id, source_workspace, conversation_id, timestamp, messages, redactions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceWorkspace,
        input.conversationId,
        input.timestamp ?? null,
        JSON.stringify(input.messages),
        input.redactions ?? 0,
        now,
      );
    return id;
  }

  /** Replace a raw conversation's scrubbed messages + redaction count (Step 1.3). */
  updateRaw(
    id: string,
    messages: RawConversation['messages'],
    redactions: number,
  ): boolean {
    const result = this.db
      .prepare('UPDATE procedure_candidates_raw SET messages = ?, redactions = ? WHERE id = ?')
      .run(JSON.stringify(messages), redactions, id);
    return result.changes > 0;
  }

  listRaw(): RawConversation[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_workspace, conversation_id, timestamp, messages, redactions
           FROM procedure_candidates_raw ORDER BY created_at`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      sourceWorkspace: String(row.source_workspace),
      conversationId: String(row.conversation_id),
      timestamp: row.timestamp === null ? null : String(row.timestamp),
      messages: parseJson(row.messages, [] as RawConversation['messages']),
      redactions: Number(row.redactions ?? 0),
    }));
  }

  countRaw(): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM procedure_candidates_raw').get() as { c: number })
        .c,
    );
  }

  clearRaw(): number {
    return Number(this.db.prepare('DELETE FROM procedure_candidates_raw').run().changes);
  }

  /** Stage a reviewed candidate (Step 1.4). Returns its id. */
  saveReview(input: Omit<ReviewCandidate, 'id'>): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO procedure_candidates_review
           (id, source_workspace, source_conversation_id, timestamp, trigger_pattern,
            keywords, steps, is_procedural, confidence, redactions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceWorkspace,
        input.sourceConversationId,
        input.timestamp ?? null,
        input.triggerPattern,
        JSON.stringify(input.keywords),
        JSON.stringify(input.steps),
        input.isProcedural ? 1 : 0,
        input.confidence,
        input.redactions,
        now,
      );
    return id;
  }

  listReview(): ReviewCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_workspace, source_conversation_id, timestamp, trigger_pattern,
                keywords, steps, is_procedural, confidence, redactions
           FROM procedure_candidates_review ORDER BY created_at`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      sourceWorkspace: String(row.source_workspace),
      sourceConversationId: String(row.source_conversation_id),
      timestamp: row.timestamp === null ? null : String(row.timestamp),
      triggerPattern: String(row.trigger_pattern),
      keywords: parseJson(row.keywords, [] as string[]),
      steps: parseJson(row.steps, [] as string[]),
      isProcedural: Number(row.is_procedural) === 1,
      confidence: Number(row.confidence),
      redactions: Number(row.redactions),
    }));
  }

  countReview(): number {
    return Number(
      (
        this.db.prepare('SELECT COUNT(*) AS c FROM procedure_candidates_review').get() as {
          c: number;
        }
      ).c,
    );
  }

  clearReview(): number {
    return Number(this.db.prepare('DELETE FROM procedure_candidates_review').run().changes);
  }

  close(): void {
    this.db.close();
  }
}
