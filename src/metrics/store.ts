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
  /** True when the tool degraded (fell back / failed) instead of running fully. */
  degraded?: boolean;
  /** Wall-clock time of the underlying tool/LLM call, in milliseconds. */
  latency_ms?: number;
  /** Serena: number of symbols the search resolved (hit-rate, not byte-savings). */
  symbols_found?: number;
  /** Serena: number of unique files found. */
  files_found?: number;
  /** Stable id linking a logical flow (e.g. classify -> optimize_context). */
  request_id?: string;
  /** Tool names the classifier recommended (adoption telemetry, classify events). */
  recommended_tools?: string[];
  /** Origin of the recorded call: 'hook' (UserPromptSubmit/SubagentStart hook) or 'mcp' (classify tool). */
  origin?: string;
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

export interface GroupedCalls {
  tool: string;
  calls: number;
}

export interface CallStats {
  tool: string;
  /** Real (non-degraded) calls. */
  calls: number;
  /** Degraded / fallback attempts. */
  degraded: number;
  /** Average tool/LLM latency in ms (null when no latency recorded). */
  avgLatencyMs: number | null;
}

export interface RequestEvent {
  tool: string;
  operation: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  symbolsFound: number | null;
  filesFound: number | null;
  degraded: boolean;
  timestamp: string;
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
  optimisation_strategy TEXT,
  degraded INTEGER,
  latency_ms INTEGER,
  symbols_found INTEGER,
  files_found INTEGER,
  request_id TEXT,
  recommended_tools TEXT,
  origin TEXT
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
    this.migrate();
  }

  /**
   * Add columns introduced after the first schema version to DBs created before
   * them, so existing metrics files upgrade in place (no manual clear needed).
   */
  private migrate(): void {
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(optimisation_events)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const additions: Array<[string, string]> = [
      ['degraded', 'ALTER TABLE optimisation_events ADD COLUMN degraded INTEGER'],
      ['latency_ms', 'ALTER TABLE optimisation_events ADD COLUMN latency_ms INTEGER'],
      ['symbols_found', 'ALTER TABLE optimisation_events ADD COLUMN symbols_found INTEGER'],
      ['files_found', 'ALTER TABLE optimisation_events ADD COLUMN files_found INTEGER'],
      ['request_id', 'ALTER TABLE optimisation_events ADD COLUMN request_id TEXT'],
      ['recommended_tools', 'ALTER TABLE optimisation_events ADD COLUMN recommended_tools TEXT'],
      ['origin', 'ALTER TABLE optimisation_events ADD COLUMN origin TEXT'],
    ];
    for (const [column, ddl] of additions) {
      if (!columns.has(column)) {
        this.db.exec(ddl);
      }
    }
  }

  /** Record an optimisation event. */
  record(event: OptimisationEvent): void {
    const baseColumns = [
      'timestamp',
      'session_id',
      'task_type',
      'complexity',
      'risk',
      'tool',
      'operation',
      'estimated_input_tokens',
      'estimated_output_tokens',
      'estimated_tokens_saved',
      'compression_ratio',
      'optimisation_strategy',
    ] as const;
    const baseValues: Array<number | string | null> = [
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
    ];
    const extra: Array<[string, number | string]> = [];
    if (event.degraded !== undefined) {
      extra.push(['degraded', event.degraded ? 1 : 0]);
    }
    if (event.latency_ms !== undefined) {
      extra.push(['latency_ms', event.latency_ms]);
    }
    if (event.symbols_found !== undefined) {
      extra.push(['symbols_found', event.symbols_found]);
    }
    if (event.files_found !== undefined) {
      extra.push(['files_found', event.files_found]);
    }
    if (event.request_id !== undefined) {
      extra.push(['request_id', event.request_id]);
    }
    if (event.recommended_tools !== undefined) {
      extra.push(['recommended_tools', JSON.stringify(event.recommended_tools)]);
    }
    if (event.origin !== undefined) {
      extra.push(['origin', event.origin]);
    }
    const columns = [...baseColumns, ...extra.map((entry) => entry[0])];
    const values = [...baseValues, ...extra.map((entry) => entry[1])];
    const placeholders = columns.map(() => '?').join(', ');
    this.db
      .prepare(`INSERT INTO optimisation_events (${columns.join(', ')})
         VALUES (${placeholders})`)
      .run(...values);
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

  /**
   * Real (non-degraded) calls per tool — degraded/fallback attempts are
   * excluded so the counter reflects genuine local tool/LLM invocations.
   */
  getCallsByTool(): GroupedCalls[] {
    const rows = this.db
      .prepare(
        `SELECT tool, COUNT(*) AS calls
         FROM optimisation_events
         WHERE degraded IS NULL OR degraded = 0
         GROUP BY tool
         ORDER BY tool`,
      )
      .all() as { tool: string; calls: number }[];
    return rows.map((row) => ({
      tool: String(row.tool),
      calls: Number(row.calls),
    }));
  }

  /**
   * Per-tool call breakdown: real calls, degraded/fallback attempts, and
   * average latency — answers "is the tool working or silently failing?".
   */
  getCallStatsByTool(): CallStats[] {
    const rows = this.db
      .prepare(
        `SELECT tool,
                SUM(CASE WHEN degraded IS NULL OR degraded = 0 THEN 1 ELSE 0 END) AS calls,
                SUM(CASE WHEN degraded = 1 THEN 1 ELSE 0 END) AS degraded,
                AVG(CASE WHEN degraded IS NULL OR degraded = 0 THEN latency_ms END) AS avgLatencyMs
         FROM optimisation_events
         GROUP BY tool
         ORDER BY tool`,
      )
      .all() as {
      tool: string;
      calls: number;
      degraded: number;
      avgLatencyMs: number | null;
    }[];
    return rows.map((row) => ({
      tool: String(row.tool),
      calls: Number(row.calls),
      degraded: Number(row.degraded),
      avgLatencyMs:
        row.avgLatencyMs === null ? null : Math.round(Number(row.avgLatencyMs)),
    }));
  }

  close(): void {
    this.db.close();
  }

  /** All recorded events for one request id, oldest first (assess_context inventory). */
  getEventsByRequestId(requestId: string): RequestEvent[] {
    const rows = this.db
      .prepare(
        `SELECT tool, operation, estimated_input_tokens, estimated_output_tokens,
                symbols_found, files_found, degraded, timestamp
         FROM optimisation_events
         WHERE request_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(requestId) as Record<string, unknown>[];
    return rows.map((row) => ({
      tool: String(row.tool),
      operation: String(row.operation),
      estimatedInputTokens: Number(row.estimated_input_tokens),
      estimatedOutputTokens: Number(row.estimated_output_tokens),
      symbolsFound:
        row.symbols_found === null || row.symbols_found === undefined
          ? null
          : Number(row.symbols_found),
      filesFound:
        row.files_found === null || row.files_found === undefined
          ? null
          : Number(row.files_found),
      degraded: Number(row.degraded) === 1,
      timestamp: String(row.timestamp),
    }));
  }

  /**
   * Classify-event breakdown by origin (hook vs mcp), with degraded counts.
   * Classify events are recorded from two paths: the UserPromptSubmit hook
   * (operation `user_prompt`, tool `classify`) and the MCP `classify` tool
   * (operation `classify`, tool `ollama`). This lets you see which mechanism is
   * doing the classification and whether it is succeeding or falling back.
   */
  getClassifyCallsByOrigin(): Array<{ origin: string; calls: number; degraded: number }> {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(origin, 'unknown') AS origin,
                SUM(CASE WHEN degraded IS NULL OR degraded = 0 THEN 1 ELSE 0 END) AS calls,
                SUM(CASE WHEN degraded = 1 THEN 1 ELSE 0 END) AS degraded
         FROM optimisation_events
         WHERE operation IN ('classify', 'user_prompt')
         GROUP BY origin
         ORDER BY origin`,
      )
      .all() as { origin: string; calls: number; degraded: number }[];
    return rows.map((row) => ({
      origin: String(row.origin),
      calls: Number(row.calls),
      degraded: Number(row.degraded),
    }));
  }

  /**
   * Adoption telemetry: how many times each tool was RECOMMENDED across classify
   * events (parsed from the `recommended_tools` JSON column). Compare with
   * `getCallStatsByTool().calls` to see recommended-vs-invoked per tool.
   */
  getRecommendedByTool(): GroupedCalls[] {
    const rows = this.db
      .prepare(
        'SELECT recommended_tools FROM optimisation_events WHERE recommended_tools IS NOT NULL',
      )
      .all() as { recommended_tools: string }[];
    const counts = new Map<string, number>();
    for (const row of rows) {
      let tools: string[];
      try {
        tools = JSON.parse(row.recommended_tools) as string[];
      } catch {
        tools = [];
      }
      for (const tool of tools) {
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((a, b) => a.tool.localeCompare(b.tool));
  }

  /** Delete all rows from the optimisation_events table; returns rows removed. */
  clear(): number {
    const result = this.db.prepare('DELETE FROM optimisation_events').run();
    return Number(result.changes);
  }

  private groupedSavings(column: 'tool' | 'task_type'): GroupedSavings[] {
    const rows = this.db
      .prepare(
        `SELECT ${column} AS key, COALESCE(SUM(estimated_tokens_saved), 0) AS estimatedTokensSaved
         FROM optimisation_events
         GROUP BY ${column}
         HAVING COALESCE(SUM(estimated_tokens_saved), 0) > 0
         ORDER BY estimatedTokensSaved DESC`,
      )
      .all() as { key: string; estimatedTokensSaved: number }[];
    return rows.map((row) => ({
      key: row.key,
      estimatedTokensSaved: Number(row.estimatedTokensSaved),
    }));
  }
}
