/**
 * `procedures` table schema + shared types (task 44).
 *
 * Repeatable action procedures with execution track records. Deliberately
 * separate from the memory service: this is NOT recalled facts/context — it is
 * a list of mechanical, repeatable tasks the local LLM can match and (for
 * low-risk tiers) execute. Naming rule: "procedure"/"procedures" only, never
 * "memory".
 */

export const RISK_TIERS = ['auto_execute', 'requires_review', 'never_auto'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const PROCEDURE_OUTCOMES = ['success', 'failure'] as const;
export type ProcedureOutcome = (typeof PROCEDURE_OUTCOMES)[number];

export const PROCEDURE_SOURCES = ['manually_seeded', 'learned_from_usage'] as const;
export type ProcedureSource = (typeof PROCEDURE_SOURCES)[number];

/** Local services the local LLM can execute on behalf of the cloud LLM. */
export const PROCEDURE_SERVICES = ['leanctx', 'serena', 'rtk'] as const;
export type ProcedureService = (typeof PROCEDURE_SERVICES)[number];

/**
 * A single executable step mapped to a local service/capability invocation.
 * Not a generic shell command — the local LLM executes these read-only
 * capabilities (LeanCTX, Serena, RTK).
 */
export interface ProcedureStep {
  service: ProcedureService;
  /** Local tool name, e.g. ctx_read, find_symbol, compress_command_output. */
  tool: string;
  /** Arguments resolved at execution time. */
  args?: Record<string, unknown>;
}

/** A single stored procedure (row in the `procedures` table). */
export interface Procedure {
  id: string;
  triggerPattern: string;
  keywords: string[];
  steps: ProcedureStep[];
  riskTier: RiskTier;
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  lastOutcome: ProcedureOutcome | null;
  source: ProcedureSource;
  createdAt: string;
  updatedAt: string;
}

/** Input for authoring a new procedure (id/timestamps/counts are derived). */
export interface ProcedureInput {
  triggerPattern: string;
  keywords: string[];
  steps: ProcedureStep[];
}

/** Input for a manually-seeded procedure: risk tier is explicit. */
export interface SeedProcedureInput extends ProcedureInput {
  riskTier: RiskTier;
}

/**
 * DDL for the `procedures` table. Uses the same `CREATE TABLE IF NOT EXISTS`
 * approach as the memory service and lives in the SAME database file, so no
 * separate service/DB is needed (Step 1 finding — reuse confirmed).
 */
export const PROCEDURES_SCHEMA = `
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  trigger_pattern TEXT NOT NULL,
  keywords TEXT NOT NULL,
  steps TEXT NOT NULL,
  risk_tier TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  last_outcome TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const PROCEDURES_COLUMNS =
  'id, trigger_pattern, keywords, steps, risk_tier, success_count, failure_count, last_used_at, last_outcome, source, created_at, updated_at';

/** Parse a JSON-encoded TEXT column back into an array (never throws). */
export function parseJsonArray(value: unknown): string[] {
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

/** Parse the `steps` column (JSON array of ProcedureStep) without throwing. */
export function parseSteps(value: unknown): ProcedureStep[] {
  if (value === null || value === undefined) {
    return [];
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const steps: ProcedureStep[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const service = rec.service;
    const tool = rec.tool;
    if (
      (PROCEDURE_SERVICES as readonly string[]).includes(String(service)) &&
      typeof tool === 'string' &&
      tool.length > 0
    ) {
      const step: ProcedureStep = {
        service: service as ProcedureService,
        tool,
      };
      if (rec.args !== undefined) {
        step.args = rec.args as Record<string, unknown>;
      }
      steps.push(step);
    }
  }
  return steps;
}
