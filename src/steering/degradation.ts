import {
  assess,
  steer,
  SteeringOptions,
  SteeringUnavailableError,
} from './ollama';
import {
  Steering,
  SteeringValidationError,
  ContextAssessment,
} from './schema';

/**
 * Conservative default used when the steering cannot run (Ollama
 * unavailable) or returns invalid output. Biased toward the highest context
 * need and lowest risk so no information is lost (safety principles §14).
 */
export const conservativeDefaultSteering: Steering = {
  task: 'investigation',
  complexity: 'high',
  risk: 'low',
  context_need: 'exhaustive',
  precision: 'normal',
  entities: [],
  tool_plan: {},
  response_policy: {
    directives: ['preserve_evidence', 'progressive_disclosure', 'no_repetition'],
  },
  guidance:
    'Advisory: investigate the request conservatively and verify facts against the project before concluding.',
  memory: { use: false },
};

export interface SteeringOutcome {
  steering: Steering;
  /** True when the steering degraded to the conservative default. */
  degraded: boolean;
  /** Why degradation happened (present when degraded). */
  reason?: string;
}

/**
 * Steer with graceful degradation (Tasks 04–05).
 *
 * Never crashes on Ollama being unavailable or on invalid/un-schema'd model
 * output — it falls back to the conservative default and surfaces the fallback
 * explicitly (logged), never silently (design doc §3, safety principle §14.1).
 *
 * Unrelated/unexpected errors are rethrown rather than swallowed.
 */
export async function steerWithFallback(
  taskText: string,
  options: SteeringOptions = {},
  steerFn: (text: string, opts?: SteeringOptions) => Promise<Steering> = steer,
): Promise<SteeringOutcome> {
  try {
    const steering = await steerFn(taskText, options);
    return { steering, degraded: false };
  } catch (err) {
    const known = err instanceof SteeringUnavailableError || err instanceof SteeringValidationError;
    if (!known) {
      throw err;
    }
    const reason = (err as Error).message;
    // Explicit, never silent.
    console.warn(`[cadet-brainstem] steering degraded to conservative default: ${reason}`);
    return {
      steering: structuredClone(conservativeDefaultSteering),
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
  options: SteeringOptions = {},
  assessFn: (
    t: string,
    i: string,
    opts?: SteeringOptions,
  ) => Promise<ContextAssessment> = assess,
): Promise<ContextAssessmentOutcome> {
  try {
    const assessment = await assessFn(taskText, inventoryText, options);
    return { assessment, degraded: false };
  } catch (err) {
    const known =
      err instanceof SteeringUnavailableError ||
      err instanceof SteeringValidationError;
    if (!known) {
      throw err;
    }
    const reason = (err as Error).message;
    console.warn(`[cadet-brainstem] assess degraded to conservative default: ${reason}`);
    return {
      assessment: structuredClone(conservativeDefaultAssessment),
      degraded: true,
      reason,
    };
  }
}
