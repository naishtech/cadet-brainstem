import { extractProcedure } from '../steering';
import type { ParsedConversation } from './parse';
import { conversationToText } from './parse';

export interface ExtractionResult {
  sourceConversationId: string;
  timestamp: string | null;
  triggerPattern: string;
  keywords: string[];
  steps: string[];
  isProcedural: boolean;
  confidence: number;
  /** True when the local LLM was unavailable/errored and we defaulted. */
  degraded: boolean;
}

const NOT_PROCEDURAL: Omit<ExtractionResult, 'sourceConversationId' | 'timestamp'> = {
  triggerPattern: '',
  keywords: [],
  steps: [],
  isProcedural: false,
  confidence: 0,
  degraded: true,
};

/** Minimum confidence (0..1) before a candidate counts as procedural. */
export const MIN_PROCEDURE_CONFIDENCE = 0.5;

/** A repeatable procedure must have at least one concrete step. */
export const MIN_PROCEDURE_STEPS = 1;

/** Patterns that indicate a trigger is NOT a procedure (error/ref text etc.). */
const BAD_TRIGGER_PATTERNS: RegExp[] = [
  /[\\/]/, // path separators
  /\.\w{1,6}\b/, // a file extension, e.g. .ts / .cs
  /:\d+(?:[,:]\d+)?/, // file:line:col
  /\b(error|exception|fatal|cancel|failure|failed)/i, // matches "cancel"/"cancellation" prefix
  /\(.*\)/, // a method signature
  /^[A-Za-z0-9_]+$/, // a bare identifier (test/method name)
];

/** True when the trigger text looks like a real, short imperative procedure. */
export function isPlausibleTrigger(pattern: string): boolean {
  const text = pattern.trim();
  if (text.length < 5 || text.length > 120) {
    return false;
  }
  return !BAD_TRIGGER_PATTERNS.some((re) => re.test(text));
}

/** Normalise the model's confidence to 0..1 (some models emit 0..100). */
export function normalizeConfidence(raw: number): number {
  const n = Number(raw);
  if (Number.isNaN(n)) {
    return 0;
  }
  return n > 1 ? n / 100 : n;
}

/**
 * Step 1.4 — decide whether a scrubbed conversation contains a repeatable,
 * mechanical task, using the same local LLM used for steering. Best
 * effort: on any failure it degrades to not-procedural (never crashes).
 *
 * Over-eager results are filtered here: a candidate only counts as procedural
 * when the model says so AND it has concrete steps AND a plausible trigger AND
 * adequate confidence. This keeps mined candidates conservative for review.
 */
export async function extractFromConversation(
  parsed: ParsedConversation,
): Promise<ExtractionResult> {
  const base = {
    sourceConversationId: parsed.conversationId,
    timestamp: parsed.timestamp,
  };
  try {
    const extraction = await extractProcedure(conversationToText(parsed));
    const confidence = normalizeConfidence(Number(extraction.confidence));
    const steps = Array.isArray(extraction.steps) ? extraction.steps : [];
    const trigger = extraction.trigger_pattern ?? '';
    const isProcedural =
      extraction.is_procedural === true &&
      steps.length >= MIN_PROCEDURE_STEPS &&
      isPlausibleTrigger(trigger) &&
      confidence >= MIN_PROCEDURE_CONFIDENCE;
    return {
      ...base,
      triggerPattern: isProcedural ? trigger : '',
      keywords: isProcedural ? extraction.keywords ?? [] : [],
      steps: isProcedural ? steps : [],
      isProcedural,
      confidence,
      degraded: false,
    };
  } catch {
    return { ...base, ...NOT_PROCEDURAL };
  }
}
