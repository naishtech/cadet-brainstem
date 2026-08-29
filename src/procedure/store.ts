import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getDefaultMemoryPath } from '../memory/store';
import {
  parseJsonArray,
  parseSteps,
  PROCEDURES_COLUMNS,
  PROCEDURES_SCHEMA,
  type Procedure,
  type ProcedureInput,
  type ProcedureOutcome,
  type ProcedureStep,
  type SeedProcedureInput,
} from './schema';

/**
 * Stable local path for the `procedures` table.
 *
 * Reuses the SAME database file as the memory service (Step 1 finding: reuse
 * the existing DB, do not stand up a separate service). Overridable via
 * `CADET_BRAINSTEM_PROCEDURES` for tests / non-default setups.
 */
export function getDefaultProcedurePath(): string {
  const env = process.env.CADET_BRAINSTEM_PROCEDURES;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return getDefaultMemoryPath();
}

function mapRow(row: Record<string, unknown>): Procedure {
  const handoffShape =
    row.handoff_shape === null || row.handoff_shape === undefined
      ? undefined
      : String(row.handoff_shape);
  return {
    id: String(row.id),
    triggerPattern: String(row.trigger_pattern),
    keywords: parseJsonArray(row.keywords),
    steps: parseSteps(row.steps),
    riskTier: String(row.risk_tier) as Procedure['riskTier'],
    ...(handoffShape !== undefined ? { handoffShape } : {}),
    successCount: Number(row.success_count),
    failureCount: Number(row.failure_count),
    lastUsedAt:
      row.last_used_at === null || row.last_used_at === undefined
        ? null
        : String(row.last_used_at),
    lastOutcome:
      row.last_outcome === null || row.last_outcome === undefined
        ? null
        : (String(row.last_outcome) as Procedure['lastOutcome']),
    source: String(row.source) as Procedure['source'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Local SQLite store for repeatable action procedures (task 44).
 *
 * Lives in the same DB file as the memory service but is a distinct table with
 * distinct semantics: it stores procedures to match/execute, not recalled
 * facts. Never store secrets or credentials in `steps`.
 */
export class ProcedureStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = getDefaultProcedurePath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(PROCEDURES_SCHEMA);
    this.migrate();
  }

  /**
   * Add columns introduced after the first schema version to DBs created
   * before them, so existing files upgrade in place (mirrors MemoryStore).
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(procedures)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ['handoff_shape', 'ALTER TABLE procedures ADD COLUMN handoff_shape TEXT'],
      // Future column additions go here, e.g.
      // ['last_outcome', 'ALTER TABLE procedures ADD COLUMN last_outcome TEXT'],
    ];
    for (const [column, ddl] of additions) {
      if (!columns.has(column)) {
        this.db.exec(ddl);
      }
    }
  }

  /** Insert a manually-authored procedure (`source: "manually_seeded"`). */
  seedProcedure(input: SeedProcedureInput): string {
    return this.insert({
      triggerPattern: input.triggerPattern,
      keywords: input.keywords,
      steps: input.steps,
      riskTier: input.riskTier,
      ...(input.handoffShape !== undefined ? { handoffShape: input.handoffShape } : {}),
      source: 'manually_seeded',
    });
  }

  /**
   * Insert a procedure discovered from real usage. `source` is forced to
   * `learned_from_usage` and `risk_tier` is forced to `requires_review`
   * regardless of what tier a similar manual entry might have — mined/learned
   * data starts conservative.
   */
  logObservedUsage(input: ProcedureInput): string {
    return this.insert({
      triggerPattern: input.triggerPattern,
      keywords: input.keywords,
      steps: input.steps,
      riskTier: 'requires_review',
      ...(input.handoffShape !== undefined ? { handoffShape: input.handoffShape } : {}),
      source: 'learned_from_usage',
    });
  }

  private insert(input: {
    triggerPattern: string;
    keywords: string[];
    steps: ProcedureStep[];
    riskTier: Procedure['riskTier'];
    handoffShape?: string;
    source: Procedure['source'];
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO procedures
           (id, trigger_pattern, keywords, steps, risk_tier, handoff_shape, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.triggerPattern,
        JSON.stringify(input.keywords),
        JSON.stringify(input.steps),
        input.riskTier,
        input.handoffShape ?? null,
        input.source,
        now,
        now,
      );
    return id;
  }

  /**
   * Return procedures whose keywords overlap the given entities, ranked by
   * overlap quality then track record. Unproven procedures (0 total runs) rank
   * below proven ones but are still returned as candidates.
   */
  findMatches(entities: string[], task: string): Procedure[] {
    const terms = new Set(
      entities
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0),
    );
    // Task text is an additional signal: fold its meaningful words in so the
    // matcher still works when entity extraction is sparse.
    for (const word of task.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 2) {
        terms.add(word);
      }
    }
    if (terms.size === 0) {
      return [];
    }

    const rows = this.db
      .prepare(`SELECT ${PROCEDURES_COLUMNS} FROM procedures`)
      .all() as Record<string, unknown>[];
    interface Candidate {
      procedure: Procedure;
      overlap: number;
    }
    const candidates: Candidate[] = [];

    for (const row of rows) {
      const procedure = mapRow(row);
      const procTerms = new Set(procedure.keywords.map((k) => k.trim().toLowerCase()));
      let overlap = 0;
      for (const term of terms) {
        if (procTerms.has(term)) {
          overlap += 1;
        }
      }
      if (overlap > 0) {
        candidates.push({ procedure, overlap });
      }
    }

    candidates.sort((a, b) => {
      // 1) Overlap quality (most matching keywords first).
      if (b.overlap !== a.overlap) {
        return b.overlap - a.overlap;
      }
      // 2) Proven (has run history) before unproven.
      const aProven = a.procedure.successCount + a.procedure.failureCount > 0;
      const bProven = b.procedure.successCount + b.procedure.failureCount > 0;
      if (aProven !== bProven) {
        return aProven ? -1 : 1;
      }
      // 3) Better success ratio first.
      const aRatio =
        a.procedure.successCount + a.procedure.failureCount === 0
          ? 0
          : a.procedure.successCount / (a.procedure.successCount + a.procedure.failureCount);
      const bRatio =
        b.procedure.successCount + b.procedure.failureCount === 0
          ? 0
          : b.procedure.successCount / (b.procedure.successCount + b.procedure.failureCount);
      return bRatio - aRatio;
    });

    return candidates.map((c) => c.procedure);
  }

  /** Record an execution outcome; updates track-record counters. */
  recordOutcome(procedureId: string, outcome: ProcedureOutcome): boolean {
    const now = new Date().toISOString();
    const column = outcome === 'success' ? 'success_count' : 'failure_count';
    const result = this.db
      .prepare(
        `UPDATE procedures
           SET ${column} = ${column} + 1,
               last_used_at = ?,
               last_outcome = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(now, outcome, now, procedureId);
    return result.changes > 0;
  }

  /** Fetch a single procedure by id. */
  get(id: string): Procedure | null {
    const row = this.db
      .prepare(`SELECT ${PROCEDURES_COLUMNS} FROM procedures WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapRow(row);
  }

  /** List all procedures (most recently updated first). */
  list(): Procedure[] {
    const rows = this.db
      .prepare(`SELECT ${PROCEDURES_COLUMNS} FROM procedures ORDER BY updated_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => mapRow(row));
  }

  /** Total number of procedures. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM procedures').get() as {
      c: number;
    };
    return Number(row.c);
  }

  /** Delete all procedures; returns rows removed. */
  clear(): number {
    const result = this.db.prepare('DELETE FROM procedures').run();
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
