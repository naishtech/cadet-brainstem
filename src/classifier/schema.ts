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

export const classificationSchema = z.object({
  task: taskTypeSchema,
  complexity: complexitySchema,
  risk: riskSchema,
  context_need: contextNeedSchema,
  precision: precisionSchema,
});

export type TaskType = z.infer<typeof taskTypeSchema>;
export type Complexity = z.infer<typeof complexitySchema>;
export type Risk = z.infer<typeof riskSchema>;
export type ContextNeed = z.infer<typeof contextNeedSchema>;
export type Precision = z.infer<typeof precisionSchema>;
export type Classification = z.infer<typeof classificationSchema>;

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
  return result.data;
}

function formatIssues(error: z.ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return `Invalid classifier output: ${details}`;
}
