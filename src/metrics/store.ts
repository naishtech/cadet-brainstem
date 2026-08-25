import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** One recorded optimisation event (design doc §8). */
export interface OptimisationEvent {
  timestamp: string;
  session_id: string;
  task_type: string;
  complexity: string;
  risk: string;
  tool: string;
  operation: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_tokens_saved: number;
  compression_ratio: number | null;
  optimisation_strategy: string | null;
}

export interface Totals {
  eventCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTokensSaved: number;
}

export interface GroupedSavings {
  key: string;
  estimatedTokensSaved: number;
}

export interface MostExpensiveOperation {
  id: number;
  tool: string;
  operation: string;
  estimatedInputTokens: number;
  estimatedTokensSaved: number;
  timestamp: string;
}

export interface SessionSummary {
  session_id: string;
  eventCount: number;
  estimatedTokensSaved: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS optimisation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL,
  estimated_output_tokens INTEGER NOT NULL,
  estimated_tokens_saved INTEGER NOT NULL,
  compression_ratio REAL,
  optimisation_strategy TEXT
);
`;

export const DEFAULT_METRICS_DIR = '.cadet-token-saver';

/**
 * Stable local path for the metrics database.
 * Overridable via CADET_TOKEN_SAVER_METRICS (useful for tests / non-default setups).
 */
export function getDefaultMetricsPath(): string {
  const env = process.env.CADET_TOKEN_SAVER_METRICS;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return join(os.homedir(), DEFAULT_METRICS_DIR, 'metrics.db');
}

/**
 * Local SQLite metrics store (design doc §8).
 *
 * Works completely offline. Records optimisation events ONLY — by design it has
 * no columns for (and never stores) source code, prompts, conversation contents,
 * file contents, API keys, or credentials (safety principle §14.7).
 */
export class MetricsStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = getDefaultMetricsPath()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Record an optimisation event. */
  record(event: OptimisationEvent): void {
    this.db
      .prepare(
        `INSERT INTO optimisation_events
          (timestamp, session_id, task_type, complexity, risk, tool, operation,
           estimated_input_tokens, estimated_output_tokens, estimated_tokens_saved,
           compression_ratio, optimisation_strategy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.timestamp,
        event.session_id,
        event.task_type,
        event.complexity,
        event.risk,
        event.tool,
        event.operation,
        event.estimated_input_tokens,
        event.estimated_output_tokens,
        event.estimated_tokens_saved,
        event.compression_ratio,
        event.optimisation_strategy,
      );
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM optimisation_events').get() as {
      c: number;
    };
    return Number(row.c);
  }

  getTotals(): Totals {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS eventCount,
                COALESCE(SUM(estimated_input_tokens), 0) AS input,
                COALESCE(SUM(estimated_output_tokens), 0) AS output,
                COALESCE(SUM(estimated_tokens_saved), 0) AS saved
         FROM optimisation_events`,
      )
      .get() as { eventCount: number; input: number; output: number; saved: number };
    return {
      eventCount: Number(row.eventCount),
      estimatedInputTokens: Number(row.input),
      estimatedOutputTokens: Number(row.output),
      estimatedTokensSaved: Number(row.saved),
    };
  }

  getSavingsByTool(): GroupedSavings[] {
    return this.groupedSavings('tool');
  }

  getSavingsByTaskType(): GroupedSavings[] {
    return this.groupedSavings('task_type');
  }

  /** Average compression ratio across events that recorded one (null if none). */
  getAverageCompressionRatio(): number | null {
    const row = this.db
      .prepare(
        'SELECT AVG(compression_ratio) AS avgRatio FROM optimisation_events WHERE compression_ratio IS NOT NULL',
      )
      .get() as { avgRatio: number | null };
    return row.avgRatio === null ? null : Number(row.avgRatio);
  }

  /** Top operations by estimated input tokens (largest context consumers). */
  getMostExpensiveOperations(limit = 10): MostExpensiveOperation[] {
    const rows = this.db
      .prepare(
        `SELECT id, tool, operation, estimated_input_tokens AS estimatedInputTokens,
                estimated_tokens_saved AS estimatedTokensSaved, timestamp
         FROM optimisation_events
         ORDER BY estimated_input_tokens DESC
         LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      tool: String(row.tool),
      operation: String(row.operation),
      estimatedInputTokens: Number(row.estimatedInputTokens),
      estimatedTokensSaved: Number(row.estimatedTokensSaved),
      timestamp: String(row.timestamp),
    }));
  }

  /** Per-session event counts and estimated savings (largest first). */
  getSessionSummary(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS eventCount,
                COALESCE(SUM(estimated_tokens_saved), 0) AS estimatedTokensSaved
         FROM optimisation_events
         GROUP BY session_id
         ORDER BY estimatedTokensSaved DESC`,
      )
      .all() as { session_id: string; eventCount: number; estimatedTokensSaved: number }[];
    return rows.map((row) => ({
      session_id: String(row.session_id),
      eventCount: Number(row.eventCount),
      estimatedTokensSaved: Number(row.estimatedTokensSaved),
    }));
  }

  close(): void {
    this.db.close();
  }

  private groupedSavings(column: 'tool' | 'task_type'): GroupedSavings[] {
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, COALESCE(SUM(estimated_tokens_saved), 0) AS estimatedTokensSaved
         FROM optimisation_events
         GROUP BY ${column}
         ORDER BY estimatedTokensSaved DESC`,
      )
      .all() as { key: string; estimatedTokensSaved: number }[];
    return rows.map((row) => ({
      key: row.key,
      estimatedTokensSaved: Number(row.estimatedTokensSaved),
    }));
  }
}
