import { z } from 'zod';

export const taskTypeSchema = z.enum([
  'question',
  'coding_new',
  'coding_fix',
  'debug',
  'refactor',
  'test',
  'review',
  'architecture',
  'documentation',
  'investigation',
  'planning',
  'search',
  'configuration',
]);

export const complexitySchema = z.enum(['low', 'medium', 'high']);
export const riskSchema = z.enum(['low', 'medium', 'high']);
export const contextNeedSchema = z.enum(['minimal', 'targeted', 'broad', 'exhaustive']);
export const precisionSchema = z.enum(['approximate', 'normal', 'exact']);

/** Context tools the agent can be told to use or skip (tool_plan). */
export const TOOL_NAMES = [
  'optimize_context',
  'find_relevant_symbols',
  'compress_command_output',
  'chat_memory_store',
  'leanctx_call',
  'leanctx_list_tools',
] as const;

export const toolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = (typeof TOOL_NAMES)[number];

export const toolPlanSchema = z.object({
  use: z.array(toolNameSchema),
});

/** Default intent text used when the model omits it for a recommended tool. */
export const RECOMMENDED_TOOL_INTENTS: Record<ToolName, string> = {
  optimize_context: 'extract and compress the relevant file context',
  find_relevant_symbols: 'semantic search for relevant symbols across the project',
  compress_command_output: 'compress noisy command output for cheap analysis',
  chat_memory_store: 'consult stored project memories as optional evidence',
  leanctx_call:
    'invoke a LeanCTX tool, e.g. ctx_shell for aggressive shell-output compression',
  leanctx_list_tools: 'discover the tools the LeanCTX MCP server exposes',
};

/** A single recommended tool paired with its intent and priority. */
export interface RecommendedTool {
  name: ToolName;
  /** Why this tool helps for this request (advisory). */
  intent: string;
  /** 1-based priority; lower runs first (cheapest-first retrieval). */
  priority: number;
  /** Optional tool-specific constraints, e.g. ["max_results:10"]. */
  constraints?: string[];
}

/** Tools the agent should use / skip, plus prioritized recommendations. */
export interface ToolPlan {
  use: ToolName[];
  skip?: ToolName[];
  /** Prioritized recommendations with intent (steers orchestration). */
  recommended_tools?: RecommendedTool[];
}

/** Search queries + initial scope the agent should start with (legacy alias). */
export interface RetrievalPlan {
  queries: string[];
  scope?: string;
}

/** A single prioritized, source-tagged retrieval query (evidence_plan). */
export interface EvidenceQuery {
  id: string;
  query: string;
  reason?: string;
  sources: string[];
  cost_estimate?: string;
  fallback?: string[];
}

/** Prioritized, source-tagged retrieval plan (replaces the older `retrieval`). */
export interface EvidencePlan {
  prioritized_queries: EvidenceQuery[];
  scope?: string;
}

/** Controller verdict: gather more context, or the signal is sufficient. */
export const verdictSchema = z.enum(['continue', 'stop']);
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * Output of the context-assessment step (`assess_context`): decide whether the
 * gathered context is sufficient and, if not, what to gather next.
 * `tool_plan` is lenient here (sanitised by `parseContextAssessment`).
 */
export const contextAssessmentSchema = z.object({
  verdict: verdictSchema,
  tool_plan: z.unknown().optional(),
  reason: z.string(),
});
export interface ContextAssessment {
  verdict: Verdict;
  tool_plan: ToolPlan;
  reason: string;
}

/** Response directives the agent can be told to follow (split response policy). */
export const RESPONSE_POLICY_KEYS = [
  'no_filler',
  'no_repetition',
  'no_tool_narration',
  'delta_only',
  'progressive_disclosure',
  'compact',
  'no_decoration',
  'no_unnecessary_formatting',
  'preserve_evidence',
  'follow_tool_plan',
] as const;

export const responsePolicyKeySchema = z.enum(RESPONSE_POLICY_KEYS);
export type ResponsePolicyKey = (typeof RESPONSE_POLICY_KEYS)[number];

export const RESPONSE_POLICY_DIRECTIVES: Record<ResponsePolicyKey, string> = {
  no_filler: 'Do not include conversational filler.',
  no_repetition: 'Do not repeat information already provided.',
  no_tool_narration:
    'Do not describe tool calls or internal steps unless relevant.',
  delta_only: 'Report only what changed or was newly discovered.',
  progressive_disclosure:
    'Give the minimum information needed; expand only when necessary.',
  compact: 'Keep output compact and information-dense.',
  no_decoration:
    'Avoid decorative formatting, emojis, and headings that add no information.',
  no_unnecessary_formatting:
    'Avoid unnecessary formatting, large markdown blocks, and decorative elements that increase token usage.',
  preserve_evidence:
    'Preserve decisions, constraints, actions, errors and evidence.',
  follow_tool_plan:
    'Honor the recommended tool plan and prefer MCP tools over raw repo search when appropriate.',
};

/** Conservative tool plan applied when the model omits a recommendation. */
export const DEFAULT_TOOL_PLAN: ToolPlan = { use: [] };
/** Default response directives applied when the model omits them. */
export const DEFAULT_RESPONSE_POLICY_KEYS: ResponsePolicyKey[] = [
  'compact',
  'no_filler',
  'no_repetition',
  'no_tool_narration',
];

/**
 * Raw model output schema. The five core fields are strict; `tool_plan` and
 * `response_policy` are lenient (sanitised by `parseClassification`) so an
 * invalid tool name or directive key never throws away a good classification.
 */
export const classificationSchema = z.object({
  task: taskTypeSchema,
  complexity: complexitySchema,
  risk: riskSchema,
  context_need: contextNeedSchema,
  precision: precisionSchema,
  tool_plan: z.unknown().optional(),
  response_policy: z.unknown().optional(),
  memory: z.unknown().optional(),
  confidence: z.unknown().optional(),
  needs_more_context: z.unknown().optional(),
  retrieval: z.unknown().optional(),
  guidance: z.unknown().optional(),
  evidence_plan: z.unknown().optional(),
});

export interface Classification {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context_need: ContextNeed;
  precision: Precision;
  tool_plan: ToolPlan;
  response_policy: ResponsePolicyKey[];
  /** Optional memory hint: whether to consult stored memories and why. */
  memory?: { use: boolean | 'if_necessary'; reason?: string };
  /** Model's self-assessed confidence in this classification (0..1). */
  confidence?: number;
  /** True when the model needs more context to classify well. */
  needs_more_context?: boolean;
  /** Search queries + initial scope to start retrieval with (legacy alias). */
  retrieval?: RetrievalPlan;
  /** One-line advisory summary of how to approach the request. */
  guidance?: string;
  /** Prioritized, source-tagged retrieval plan (replaces `retrieval`). */
  evidence_plan?: EvidencePlan;
}

export type TaskType = z.infer<typeof taskTypeSchema>;
export type Complexity = z.infer<typeof complexitySchema>;
export type Risk = z.infer<typeof riskSchema>;
export type ContextNeed = z.infer<typeof contextNeedSchema>;
export type Precision = z.infer<typeof precisionSchema>;

function isToolName(value: unknown): value is ToolName {
  return (
    typeof value === 'string' &&
    (TOOL_NAMES as readonly string[]).includes(value)
  );
}

function isResponsePolicyKey(value: unknown): value is ResponsePolicyKey {
  return (
    typeof value === 'string' &&
    (RESPONSE_POLICY_KEYS as readonly string[]).includes(value)
  );
}

/** Keep only entries that pass the predicate; drop invalid / non-string ones. */
function sanitizeStringList<T extends string>(
  raw: unknown,
  predicate: (value: unknown) => value is T,
): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: T[] = [];
  for (const item of raw) {
    if (predicate(item)) {
      result.push(item);
    }
  }
  return result;
}

function sanitizeToolPlan(raw: unknown): ToolPlan {
  if (typeof raw !== 'object' || raw === null) {
    return { use: [] };
  }
  const plan = raw as {
    use?: unknown;
    skip?: unknown;
    recommended_tools?: unknown;
  };
  const use = sanitizeStringList(plan.use, isToolName);
  const skip = sanitizeStringList(plan.skip, isToolName);
  const recommended = sanitizeRecommendedTools(plan.recommended_tools);
  const result: ToolPlan = { use };
  if (skip.length > 0) {
    result.skip = skip;
  }
  if (recommended !== undefined) {
    result.recommended_tools = recommended;
  }
  return result;
}

/** Keep valid recommended tools; fill missing intent, drop invalid names. */
function sanitizeRecommendedTools(
  raw: unknown,
): RecommendedTool[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const result: RecommendedTool[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const t = item as {
      name?: unknown;
      intent?: unknown;
      priority?: unknown;
      constraints?: unknown;
    };
    if (!isToolName(t.name)) {
      continue;
    }
    const intent =
      typeof t.intent === 'string' && t.intent.trim().length > 0
        ? t.intent.trim().slice(0, 200)
        : RECOMMENDED_TOOL_INTENTS[t.name];
    const priority =
      typeof t.priority === 'number' && Number.isFinite(t.priority)
        ? t.priority
        : 0;
    const constraints = sanitizeStringList(
      t.constraints,
      (value): value is string => typeof value === 'string',
    );
    result.push({
      name: t.name,
      intent,
      priority,
      ...(constraints.length > 0 ? { constraints } : {}),
    });
  }
  return result.length > 0 ? result : undefined;
}

function sanitizeResponsePolicy(raw: unknown): ResponsePolicyKey[] {
  const keys = sanitizeStringList(raw, isResponsePolicyKey);
  return keys.length > 0 ? keys : DEFAULT_RESPONSE_POLICY_KEYS;
}

/** Keep a finite 0..1 confidence, else undefined (model said nothing useful). */
function sanitizeConfidence(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : undefined;
}

function sanitizeBoolean(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

function normalizeScope(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  return raw
    .trim()
    .replace(/[_]+/g, ' ')
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s+/g, ' ');
}

/** Keep a retrieval plan only when it carries at least one query or a scope. */
function sanitizeRetrieval(raw: unknown): RetrievalPlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const plan = raw as { queries?: unknown; scope?: unknown };
  const queries = sanitizeStringList(
    plan.queries,
    (value): value is string => typeof value === 'string',
  );
  const scope = normalizeScope(plan.scope);
  if (queries.length === 0 && scope === undefined) {
    return undefined;
  }
  return { queries, ...(scope !== undefined ? { scope } : {}) };
}

/** Keep a short one-line advisory, else undefined. */
function sanitizeGuidance(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text.length === 0) {
    return undefined;
  }
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/** Keep a prioritized evidence plan, else undefined. */
function sanitizeEvidencePlan(raw: unknown): EvidencePlan | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const plan = raw as { prioritized_queries?: unknown; scope?: unknown };
  const queries = sanitizeEvidenceQueries(plan.prioritized_queries);
  const scope = normalizeScope(plan.scope);
  if (queries.length === 0 && scope === undefined) {
    return undefined;
  }
  const result: EvidencePlan = { prioritized_queries: queries };
  if (scope !== undefined) {
    result.scope = scope;
  }
  return result;
}

/** Sanitize evidence queries, dropping entries without a usable query. */
function sanitizeEvidenceQueries(raw: unknown): EvidenceQuery[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: EvidenceQuery[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const q = item as {
      id?: unknown;
      query?: unknown;
      reason?: unknown;
      sources?: unknown;
      cost_estimate?: unknown;
      fallback?: unknown;
    };
    if (typeof q.query !== 'string' || q.query.trim().length === 0) {
      continue;
    }
    const sources = sanitizeStringList(
      q.sources,
      (value): value is string => typeof value === 'string',
    );
    const fallback = sanitizeStringList(
      q.fallback,
      (value): value is string => typeof value === 'string',
    );
    const id =
      typeof q.id === 'string' && q.id.trim().length > 0
        ? q.id.trim().slice(0, 40)
        : `q${result.length + 1}`;
    const entry: EvidenceQuery = {
      id,
      query: q.query.trim().slice(0, 200),
      sources: sources.length > 0 ? sources : ['serena', 'file_search'],
    };
    if (typeof q.reason === 'string' && q.reason.trim().length > 0) {
      entry.reason = q.reason.trim().slice(0, 200);
    }
    if (
      typeof q.cost_estimate === 'string' &&
      q.cost_estimate.trim().length > 0
    ) {
      entry.cost_estimate = q.cost_estimate.trim().slice(0, 40);
    }
    if (fallback.length > 0) {
      entry.fallback = fallback;
    }
    result.push(entry);
  }
  return result;
}

/** Build an evidence plan from the legacy `retrieval` alias. */
function evidencePlanFromRetrieval(retrieval: RetrievalPlan): EvidencePlan {
  const prioritized_queries: EvidenceQuery[] = retrieval.queries.map(
    (query, i) => ({
      id: `q${i + 1}`,
      query,
      sources: ['serena', 'file_search'],
      cost_estimate: 'cheap',
    }),
  );
  const result: EvidencePlan = { prioritized_queries };
  if (retrieval.scope !== undefined) {
    result.scope = retrieval.scope;
  }
  return result;
}

function sanitizeMemory(raw: unknown): { use: boolean | 'if_necessary'; reason?: string } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { use?: unknown; reason?: unknown };
  if (m.use === 'if_necessary') {
    return typeof m.reason === 'string' && m.reason.length > 0
      ? { use: 'if_necessary', reason: m.reason.trim() }
      : { use: 'if_necessary' };
  }
  if (typeof m.use !== 'boolean') return undefined;
  return typeof m.reason === 'string' && m.reason.length > 0
    ? { use: m.use, reason: m.reason.trim() }
    : { use: m.use };
}

/** Raised when classifier output does not match the classification schema. */
export class ClassificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassificationValidationError';
  }
}

/**
 * Parse and validate classifier output (a JSON string or already-parsed object)
 * against the classification schema.
 *
 * Invalid output throws a clear error — the degradation layer (Task 05) is
 * responsible for deciding how to fall back conservatively.
 */
export function parseClassification(raw: unknown): Classification {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // Leave the raw string so schema validation fails with a clear reason.
      parsed = raw;
    }
  }

  const result = classificationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClassificationValidationError(formatIssues(result.error));
  }
  const confidence = sanitizeConfidence(result.data.confidence);
  const needsMoreContext = sanitizeBoolean(result.data.needs_more_context);
  const retrieval = sanitizeRetrieval(result.data.retrieval);
  const guidance = sanitizeGuidance(result.data.guidance);
  const evidencePlan =
    sanitizeEvidencePlan(result.data.evidence_plan) ??
    (retrieval !== undefined ? evidencePlanFromRetrieval(retrieval) : undefined);
  const memory = sanitizeMemory(result.data.memory);
  return {
    task: result.data.task,
    complexity: result.data.complexity,
    risk: result.data.risk,
    context_need: result.data.context_need,
    precision: result.data.precision,
    tool_plan: sanitizeToolPlan(result.data.tool_plan),
    response_policy: sanitizeResponsePolicy(result.data.response_policy),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(needsMoreContext !== undefined ? { needs_more_context: needsMoreContext } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    ...(evidencePlan !== undefined ? { evidence_plan: evidencePlan } : {}),
    ...(memory !== undefined ? { memory } : {}),
  };
}

/** Parse and validate a context assessment (JSON string or object). */
export function parseContextAssessment(raw: unknown): ContextAssessment {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = raw;
    }
  }
  const result = contextAssessmentSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClassificationValidationError(formatIssues(result.error));
  }
  return {
    verdict: result.data.verdict,
    tool_plan: sanitizeToolPlan(result.data.tool_plan),
    reason: result.data.reason,
  };
}

function formatIssues(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `Invalid classifier output: ${details}`;
}
