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

/** The 13 task types as a runtime array (for multi-task sanitization). */
export const TASK_TYPES = [
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
] as const;

export const complexitySchema = z.enum(['low', 'medium', 'high']);
export const riskSchema = z.enum(['low', 'medium', 'high']);
export const contextNeedSchema = z.enum(['minimal', 'targeted', 'broad', 'exhaustive']);
export const precisionSchema = z.enum(['approximate', 'normal', 'exact']);

/** Recommended documentation language standard the classifier may pick. */
export const LANGUAGE_STANDARDS = [
  'asd_ste100',
  'microsoft',
  'google',
  'diataxis',
  'iso_24495',
  'ieee',
] as const;

export const languageStandardSchema = z.enum(LANGUAGE_STANDARDS);
export type LanguageStandard = z.infer<typeof languageStandardSchema>;

/** Human-readable guidance for each language standard (for the prompt). */
export const LANGUAGE_STANDARD_DESCRIPTIONS: Record<LanguageStandard, string> = {
  asd_ste100:
    'ASD-STE100 — controlled language; maximum clarity, minimal ambiguity (safety-critical, runbooks, instructions)',
  microsoft:
    'Microsoft Style Guide — house style; consistency, UI terminology (developer docs, product docs)',
  google:
    'Google Style Guide — house style; concise, example-driven (API docs, tutorials)',
  diataxis: 'Diátaxis — structure; reader-mode clarity (documentation portals)',
  iso_24495:
    'ISO 24495 — controlled language; plain language (general tech writing)',
  ieee: 'IEEE Style — academic; formal precision (research, standards)',
};

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
  recommended_tools: z.unknown().optional(),
  skip: z.array(toolNameSchema).optional(),
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

/**
 * Tools the agent should use. `recommended_tools` is the canonical list
 * (each entry carries the tool name + intent + priority); `skip` is an
 * optional explicit don't-use list (rarely populated).
 */
export interface ToolPlan {
  /** Prioritized recommendations with intent (steers orchestration). */
  recommended_tools?: RecommendedTool[];
  /** Tools the agent should skip (optional, rarely populated). */
  skip?: ToolName[];
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

/**
 * A single tool-anchored reminder (replaces the one-line `guidance`). `tool`
 * is a hint label (advisory — may be a tool name or a category like `git`,
 * `shell`, `rtk`); `message` is one short concrete directive.
 */
export interface Reminder {
  tool: string;
  message: string;
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
export const DEFAULT_TOOL_PLAN: ToolPlan = {};
/** Default response directives applied when the model omits them. */
export const DEFAULT_RESPONSE_POLICY_KEYS: ResponsePolicyKey[] = [
  'compact',
  'no_filler',
  'no_repetition',
  'no_tool_narration',
];

/**
 * Response policy the cloud LLM should follow when composing its reply.
 * Holds the behavioral directive keys plus optional categorical choices
 * (e.g. a recommended documentation `language_standard`).
 */
export interface ResponsePolicy {
  /** Behavioral directives to apply when replying. */
  directives: ResponsePolicyKey[];
  /** Optional recommended documentation language standard. */
  language_standard?: LanguageStandard;
}

/**
 * JSON Schema describing the lean LLM classification output. Passed to Ollama
 * via the `format` parameter so the model emits valid structured JSON directly.
 *
 * The model only does classification + simple entity/keyword extraction. It
 * does NOT reason about tools or retrieval here — `tool_plan` / `evidence_plan`
 * (the fields that drive token savings) are synthesized deterministically in
 * code from `entities` + `context_need` (see `src/classifier/synthesize.ts`).
 * Keeping the model's job small makes it fast AND specific (entities are pulled
 * verbatim from the request, not invented).
 *
 * Kept in sync with the Modelfile SYSTEM block. `additionalProperties: false`
 * enforces the shape at every level.
 */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', enum: [...TASK_TYPES] },
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    context_need: {
      type: 'string',
      enum: ['minimal', 'targeted', 'broad', 'exhaustive'],
    },
    // Simple noun/keyword extraction straight from the request (e.g. "blueprint",
    // "X300", "Docs/Components"). NOT reasoning about which tools to use.
    entities: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    needs_more_context: { type: 'boolean' },
  },
  required: [
    'task',
    'complexity',
    'risk',
    'context_need',
    'entities',
    'confidence',
    'needs_more_context',
  ],
  additionalProperties: false,
} as const;

/**
 * Raw model output schema. The five core fields are strict; `tool_plan` and
 * `response_policy` are lenient (sanitised by `parseClassification`) so an
 * invalid tool name or directive key never throws away a good classification.
 */
export const classificationSchema = z.object({
  // Token-saving fields first so the cloud LLM reads them first.
  response_policy: z.unknown().optional(),
  reminders: z.unknown().optional(),
  tool_plan: z.unknown().optional(),
  context_need: contextNeedSchema,
  task: taskTypeSchema,
  entities: z.array(z.string()),
  subtasks: z.unknown().optional(),
  precision: precisionSchema.optional(),
  evidence_plan: z.unknown().optional(),
  retrieval: z.unknown().optional(),
  complexity: complexitySchema,
  risk: riskSchema,
  guidance: z.unknown().optional(),
  memory: z.unknown().optional(),
  confidence: z.unknown().optional(),
  needs_more_context: z.unknown().optional(),
});

/**
 * Procedure-extraction output (task 45 mining Step 1.4): does a conversation
 * contain a repeatable, mechanical task, and if so what are its trigger,
 * keywords and steps? Classification/extraction — not synthesis.
 */
export const procedureExtractionSchema = z.object({
  is_procedural: z.boolean(),
  trigger_pattern: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  confidence: z.number().default(0),
});
export type ProcedureExtraction = z.infer<typeof procedureExtractionSchema>;

export const PROCEDURE_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_procedural: { type: 'boolean' },
    trigger_pattern: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['is_procedural', 'trigger_pattern', 'keywords', 'steps', 'confidence'],
  additionalProperties: false,
} as const;

/** Parse and validate local-LLM procedure-extraction output. */
export function parseProcedureExtraction(raw: unknown): ProcedureExtraction {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = raw;
    }
  }
  const result = procedureExtractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClassificationValidationError('invalid procedure extraction output');
  }
  return result.data;
}

export interface Classification {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context_need: ContextNeed;
  precision: Precision;
  /** Nouns/keywords pulled directly from the request (drives deterministic synthesis). */
  entities: string[];
  tool_plan: ToolPlan;
  /** Response policy the cloud LLM should follow (directives + choices). */
  response_policy: ResponsePolicy;
  /** Optional memory hint: whether to consult stored memories and why. */
  memory?: { use: boolean | 'if_necessary'; reason?: string };
  /** Model's self-assessed confidence in this classification (0..1). */
  confidence?: number;
  /** True when the model needs more context to classify well. */
  needs_more_context?: boolean;
  /** Search queries + initial scope to start retrieval with (legacy alias). */
  retrieval?: RetrievalPlan;
  /** One-line advisory summary of how to approach the request (deprecated alias). */
  guidance?: string;
  /** Prioritized, source-tagged retrieval plan (replaces `retrieval`). */
  evidence_plan?: EvidencePlan;
  /** Tool-anchored reminders the cloud LLM should honor (replaces `guidance`). */
  reminders?: Reminder[];
  /** Additional distinct task types detected (multi-task requests). */
  subtasks?: TaskType[];
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
    return {};
  }
  const plan = raw as {
    use?: unknown;
    skip?: unknown;
    recommended_tools?: unknown;
  };
  const skip = sanitizeStringList(plan.skip, isToolName);
  const recommended = sanitizeRecommendedTools(plan.recommended_tools);
  const result: ToolPlan = {};
  if (recommended !== undefined) {
    result.recommended_tools = recommended;
  } else {
    // Backward compatibility: a legacy flat `use` array becomes recommended_tools.
    const legacyUse = sanitizeStringList(plan.use, isToolName);
    if (legacyUse.length > 0) {
      result.recommended_tools = legacyUse.map((name, i) => ({
        name,
        intent: RECOMMENDED_TOOL_INTENTS[name],
        priority: i + 1,
      }));
    }
  }
  if (skip.length > 0) {
    result.skip = skip;
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

function sanitizeResponsePolicy(raw: unknown): ResponsePolicy {
  const result: ResponsePolicy = { directives: DEFAULT_RESPONSE_POLICY_KEYS };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const r = raw as { directives?: unknown; language_standard?: unknown };
    const keys = sanitizeStringList(r.directives, isResponsePolicyKey);
    if (keys.length > 0) {
      // Dedupe: the model sometimes repeats a directive (e.g. preserve_evidence x3).
      result.directives = [...new Set(keys)];
    }
    const languageStandard = sanitizeLanguageStandard(r.language_standard);
    if (languageStandard !== undefined) {
      result.language_standard = languageStandard;
    }
    return result;
  }
  // Legacy flat-array form — treat as the directive list.
  const keys = sanitizeStringList(raw, isResponsePolicyKey);
  if (keys.length > 0) {
    result.directives = [...new Set(keys)];
  }
  return result;
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

/** Keep a valid language standard, else undefined (model said nothing useful). */
function sanitizeLanguageStandard(raw: unknown): LanguageStandard | undefined {
  return typeof raw === 'string' &&
    (LANGUAGE_STANDARDS as readonly string[]).includes(raw)
    ? (raw as LanguageStandard)
    : undefined;
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

/** Keep valid tool-anchored reminders (non-empty tool+message, capped). */
function sanitizeReminders(raw: unknown): Reminder[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const result: Reminder[] = [];
  for (const item of raw.slice(0, 8)) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const r = item as { tool?: unknown; message?: unknown };
    if (
      typeof r.tool !== 'string' ||
      r.tool.trim().length === 0 ||
      typeof r.message !== 'string' ||
      r.message.trim().length === 0
    ) {
      continue;
    }
    result.push({
      tool: r.tool.trim().slice(0, 40),
      message: r.message.trim().slice(0, 200),
    });
  }
  return result.length > 0 ? result : undefined;
}

/** Keep distinct, valid task types (multi-task detection). */
function sanitizeSubtasks(raw: unknown): TaskType[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: TaskType[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const key = item as string;
    if (!(TASK_TYPES as readonly string[]).includes(key)) {
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key as TaskType);
    }
  }
  return result.length > 0 ? result : undefined;
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
  const reminders = sanitizeReminders(result.data.reminders);
  const subtasks = sanitizeSubtasks(result.data.subtasks);
  const evidencePlan =
    sanitizeEvidencePlan(result.data.evidence_plan) ??
    (retrieval !== undefined ? evidencePlanFromRetrieval(retrieval) : undefined);
  const memory = sanitizeMemory(result.data.memory);
  return {
    task: result.data.task,
    complexity: result.data.complexity,
    risk: result.data.risk,
    context_need: result.data.context_need,
    precision: result.data.precision ?? 'normal',
    entities: result.data.entities,
    tool_plan: sanitizeToolPlan(result.data.tool_plan),
    response_policy: sanitizeResponsePolicy(result.data.response_policy),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(needsMoreContext !== undefined ? { needs_more_context: needsMoreContext } : {}),
    ...(retrieval !== undefined ? { retrieval } : {}),
    // `guidance` is a deprecated alias — derive it from the first reminder
    // when the model emits reminders but no guidance.
    ...(guidance !== undefined
      ? { guidance }
      : reminders !== undefined && reminders.length > 0
        ? { guidance: reminders[0]!.message }
        : {}),
    ...(reminders !== undefined ? { reminders } : {}),
    ...(subtasks !== undefined ? { subtasks } : {}),
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
