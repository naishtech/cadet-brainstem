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
] as const;

export const toolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = (typeof TOOL_NAMES)[number];

export const toolPlanSchema = z.object({
  use: z.array(toolNameSchema),
  skip: z.array(toolNameSchema),
});
export type ToolPlan = z.infer<typeof toolPlanSchema>;

/** Search queries + initial scope the agent should start with (retrieval plan). */
export interface RetrievalPlan {
  queries: string[];
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
  'preserve_evidence',
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
  preserve_evidence:
    'Preserve decisions, constraints, actions, errors and evidence.',
};

/** Conservative tool plan applied when the model omits a recommendation. */
export const DEFAULT_TOOL_PLAN: ToolPlan = { use: [], skip: [] };
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
  confidence: z.unknown().optional(),
  needs_more_context: z.unknown().optional(),
  retrieval: z.unknown().optional(),
});

export interface Classification {
  task: TaskType;
  complexity: Complexity;
  risk: Risk;
  context_need: ContextNeed;
  precision: Precision;
  tool_plan: ToolPlan;
  response_policy: ResponsePolicyKey[];
  /** Model's self-assessed confidence in this classification (0..1). */
  confidence?: number;
  /** True when the model needs more context to classify well. */
  needs_more_context?: boolean;
  /** Search queries + initial scope to start retrieval with. */
  retrieval?: RetrievalPlan;
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
    return { use: [], skip: [] };
  }
  const plan = raw as { use?: unknown; skip?: unknown };
  return {
    use: sanitizeStringList(plan.use, isToolName),
    skip: sanitizeStringList(plan.skip, isToolName),
  };
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
  const scope =
    typeof plan.scope === 'string' && plan.scope.length > 0
      ? plan.scope
      : undefined;
  if (queries.length === 0 && scope === undefined) {
    return undefined;
  }
  return { queries, ...(scope !== undefined ? { scope } : {}) };
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
