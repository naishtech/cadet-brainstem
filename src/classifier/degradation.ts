import {
  assess,
  classify,
  ClassifierOptions,
  ClassifierUnavailableError,
} from './ollama';
import {
  Classification,
  ClassificationValidationError,
  ContextAssessment,
} from './schema';

/**
 * Conservative default used when the classifier cannot run (Ollama
 * unavailable) or returns invalid output. Biased toward the highest context
 * need and lowest risk so no information is lost (safety principles §14).
 */
export const conservativeDefaultClassification: Classification = {
  task: 'investigation',
  complexity: 'high',
  risk: 'low',
  context_need: 'exhaustive',
  precision: 'normal',
  tool_plan: {},
  response_policy: {
    directives: ['preserve_evidence', 'progressive_disclosure', 'no_repetition'],
  },
  guidance:
    'Advisory: investigate the request conservatively and verify facts against the project before concluding.',
  memory: { use: false },
};

export interface ClassificationOutcome {
  classification: Classification;
  /** True when the classifier degraded to the conservative default. */
  degraded: boolean;
  /** Why degradation happened (present when degraded). */
  reason?: string;
}

/**
 * Classify with graceful degradation (Tasks 04–05).
 *
 * Never crashes on Ollama being unavailable or on invalid/un-schema'd model
 * output — it falls back to the conservative default and surfaces the fallback
 * explicitly (logged), never silently (design doc §3, safety principle §14.1).
 *
 * Unrelated/unexpected errors are rethrown rather than swallowed.
 */
export async function classifyWithFallback(
  taskText: string,
  options: ClassifierOptions = {},
  classifyFn: (text: string, opts?: ClassifierOptions) => Promise<Classification> = classify,
): Promise<ClassificationOutcome> {
  try {
    const classification = await classifyFn(taskText, options);
    return { classification, degraded: false };
  } catch (err) {
    const known = err instanceof ClassifierUnavailableError || err instanceof ClassificationValidationError;
    if (!known) {
      throw err;
    }
    const reason = (err as Error).message;
    // Explicit, never silent.
    console.warn(`[cadet-token-saver] classifier degraded to conservative default: ${reason}`);
    return {
      classification: structuredClone(conservativeDefaultClassification),
      degraded: true,
      reason,
    };
  }
}

/** Conservative assessment used when the controller cannot run: stop the loop. */
export const conservativeDefaultAssessment: ContextAssessment = {
  verdict: 'stop',
  tool_plan: {},
  reason: 'controller unavailable — no loop',
};

export interface ContextAssessmentOutcome {
  assessment: ContextAssessment;
  /** True when the controller degraded to the conservative default. */
  degraded: boolean;
  /** Why degradation happened (present when degraded). */
  reason?: string;
}

/**
 * Assess context sufficiency with graceful degradation. Never crashes on
 * Ollama being unavailable or on invalid output — it falls back to a
 * conservative "stop" (no loop) and surfaces the fallback explicitly.
 */
export async function assessWithFallback(
  taskText: string,
  inventoryText: string,
  options: ClassifierOptions = {},
  assessFn: (
    t: string,
    i: string,
    opts?: ClassifierOptions,
  ) => Promise<ContextAssessment> = assess,
): Promise<ContextAssessmentOutcome> {
  try {
    const assessment = await assessFn(taskText, inventoryText, options);
    return { assessment, degraded: false };
  } catch (err) {
    const known =
      err instanceof ClassifierUnavailableError ||
      err instanceof ClassificationValidationError;
    if (!known) {
      throw err;
    }
    const reason = (err as Error).message;
    console.warn(`[cadet-token-saver] assess degraded to conservative default: ${reason}`);
    return {
      assessment: structuredClone(conservativeDefaultAssessment),
      degraded: true,
      reason,
    };
  }
}
