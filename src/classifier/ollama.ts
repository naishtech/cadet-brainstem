import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/index';
import Mustache from 'mustache';
import {
  CLASSIFICATION_JSON_SCHEMA,
  Classification,
  ClassificationValidationError,
  TOOL_NAMES,
  parseClassification,
  parseContextAssessment,
  type ContextAssessment,
} from './schema';

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 30_000;

/** How long the model is kept loaded between calls (Ollama keep_alive). */
export const DEFAULT_KEEP_ALIVE = '30m';

/** Modelfile-derived classifier model (built via `ollama create`). */
export const DERIVED_CLASSIFIER_MODEL = 'fast-classifier';
/** Max tokens to generate for a classification decision. */
export const DEFAULT_NUM_PREDICT = 400;
/** Context window sized to the actual prompt+schema length. */
export const DEFAULT_NUM_CTX = 2048;

/** Raised when Ollama is unreachable or returns a non-OK/invalid response. */
export class ClassifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierUnavailableError';
  }
}

export interface ClassifierOptions {
  /** Overrides the configured `classifier.model`. */
  model?: string;
  /** Overrides `OLLAMA_HOST` / the default localhost host. */
  host?: string;
  timeoutMs?: number;
  /** Latency/metrics log sink. Defaults to console.log. */
  log?: (line: string) => void;
}

const CLASSIFICATION_SHAPE = `{
  "task": "question | coding_new | coding_fix | debug | refactor | test | review | architecture | documentation | investigation | planning | search | configuration",
  "complexity": "low | medium | high",
  "risk": "low | medium | high",
  "context_need": "minimal | targeted | broad | exhaustive",
  "entities": ["<noun or keyword pulled directly from the request>", "<another>"],
  "confidence": 0.0,
  "needs_more_context": false
}`;

const DEFAULT_CLASSIFIER_PROMPT_TEMPLATE = `You are a task classifier for an AI coding agent context optimizer.
Classify the user request ONLY — do NOT solve it, do NOT suggest tools or
search queries (that is handled separately), do NOT invent information.

Respond with exactly this JSON shape:
{{{classificationShape}}}

task: "review" is for reviewing existing code, changes, or a PR.
Do not use "review" for design, planning, architecture, or exploratory requests.
For requests that ask to design, plan, investigate, or explore an approach, prefer
"investigation" or "planning" instead of "review".

complexity: low=single file, obvious; medium=multiple files OR design decisions;
high=cross-cutting, unclear requirements, many files.

risk: low=reversible, no prod/data/security impact; medium=shared code/tests/
user-facing; high=auth, payments, data migrations, prod config, or deletes data.

context_need: size it to THIS request. A narrow question about one convention
or area is "targeted"; reserve "broad"/"exhaustive" for tasks that genuinely
need the whole repository; "minimal" when no repo access is needed.

entities: a list of the key NOUNS and keywords literally present (or clearly
implied) in the request — e.g. "checkout page", "blueprint", "X300",
"Docs/Components". Simple EXTRACTION, NOT reasoning: do not invent tools, do not
reason about how to accomplish the task. 2-6 entries is typical.

confidence: a number 0..1 for how sure you are of this classification.
needs_more_context: true only when you cannot classify well without seeing
more of the repository.

User request:
"""
{{{userRequest}}}
"""`;

function loadClassifierPromptTemplate(): string {
  try {
    return readFileSync(new URL('./classifier-prompt.mustache', import.meta.url), 'utf8');
  } catch {
    return DEFAULT_CLASSIFIER_PROMPT_TEMPLATE;
  }
}

/** Build the classifier prompt. It instructs the model to classify ONLY. */
export function buildPrompt(taskText: string, template?: string): string {
  const promptTemplate = template ?? loadClassifierPromptTemplate();
  return Mustache.render(promptTemplate, {
    classificationShape: CLASSIFICATION_SHAPE,
    userRequest: taskText,
  });
}

const ASSESSMENT_SHAPE = `{
  "verdict": "continue | stop",
  "tool_plan": { "use": ["<tool>"] },
  "reason": "<one short sentence>"
}`;

/** Build the context-assessment prompt: is the gathered signal sufficient? */
export function buildAssessPrompt(taskText: string, inventoryText: string): string {
  const tools = TOOL_NAMES.join(', ');
  return [
    'You are the context controller for an AI coding agent.',
    'Decide what context the cloud model needs next.',
    'Rules:',
    '- decide only; do not solve, answer, or explain the task',
    '- return JSON only, with no commentary and no markdown fences',
    '- "stop" only when the gathered context is likely sufficient; otherwise "continue" with the single highest-value tool',
    '- be aggressive: put any tool that clearly will not help into skip',
    '',
    `Available context tools: ${tools}`,
    '',
    `Respond with exactly this JSON shape:\n${ASSESSMENT_SHAPE}`,
    '',
    'Task:',
    '"""',
    taskText,
    '"""',
    '',
    'Context gathered so far:',
    '"""',
    inventoryText,
    '"""',
  ].join('\n');
}

/** Lightweight ping — true when the Ollama server responds to /api/tags. */
export async function isOllamaAvailable(
  host = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True when the configured model is present on the Ollama server. */
export async function isModelAvailable(
  model: string,
  host = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const names = data.models?.map((m) => m.name) ?? [];
    return names.some((n) => n === model || n.startsWith(`${model}:`));
  } catch {
    return false;
  }
}

/**
 * Local Ollama classifier. Uses HTTP only — it never executes or constructs
 * shell commands (safety principle §14.4). Model and host come from config
 * (with env/host override), never hard-coded.
 */
export class OllamaClassifier {
  readonly model: string;
  readonly host: string;
  readonly timeoutMs: number;
  readonly keepAlive: string;
  readonly log: (line: string) => void;

  constructor(options: ClassifierOptions = {}) {
    this.model = resolveModel(options.model);
    this.host =
      options.host !== undefined && options.host.length > 0
        ? options.host
        : (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
    this.timeoutMs = options.timeoutMs ?? resolveTimeoutMs();
    this.keepAlive = resolveKeepAlive();
    this.log = options.log ?? defaultLog;
  }

  async isAvailable(): Promise<boolean> {
    return isOllamaAvailable(this.host);
  }

  async classify(taskText: string): Promise<Classification> {
    // The Modelfile-derived classifier carries the static instructions in its
    // SYSTEM block, so the request prompt contains ONLY the user's text. The
    // base model still needs the full prompt template with the field defs.
    const prompt = isDerivedClassifierModel(this.model)
      ? taskText
      : buildPrompt(taskText);
    return parseClassification(await this.chatJson(prompt, CLASSIFICATION_JSON_SCHEMA));
  }

  /** Decide whether the context gathered so far is sufficient (assess_context). */
  async assess(
    taskText: string,
    inventoryText: string,
  ): Promise<ContextAssessment> {
    return parseContextAssessment(
      await this.chatJson(buildAssessPrompt(taskText, inventoryText)),
    );
  }

  /** One chat round-trip returning the model's JSON text content. */
  private async chatJson(
    prompt: string,
    format: unknown = 'json',
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          // Structured output for classify: pass the JSON Schema so the model
          // emits valid JSON matching the classification shape. Assess keeps
          // plain JSON mode (no schema).
          format,
          // Disable qwen3 reasoning/thinking — we only need a short structured
          // decision, so thinking wastes tokens and latency.
          think: false,
          // Keep the model warm between calls so a cold reload (which can take
          // ~10s on CPU) doesn't blow the timeout.
          keep_alive: this.keepAlive,
          options: {
            temperature: 0,
            num_predict: DEFAULT_NUM_PREDICT,
            num_ctx: DEFAULT_NUM_CTX,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ClassifierUnavailableError(
        `Could not reach Ollama at ${this.host}: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new ClassifierUnavailableError(
        `Ollama responded with HTTP ${response.status} at ${this.host}`,
      );
    }

    let data: { message?: { content?: unknown } };
    try {
      data = (await response.json()) as { message?: { content?: unknown } };
    } catch (err) {
      throw new ClassifierUnavailableError(
        `Ollama returned invalid JSON: ${(err as Error).message}`,
      );
    }

    if (data.message === undefined || typeof data.message.content !== 'string') {
      throw new ClassifierUnavailableError('Ollama returned no message content');
    }

    // Latency instrumentation (nanoseconds) — lets us tell whether load,
    // prefill (prompt_eval) or generation (eval) is the bottleneck.
    const d = data as typeof data & {
      total_duration?: number;
      load_duration?: number;
      prompt_eval_duration?: number;
      eval_duration?: number;
    };
    this.log(
      `[cadet-brainstem] classifier durations (ns) model=${this.model} ` +
        `total=${d.total_duration ?? 'n/a'} load=${d.load_duration ?? 'n/a'} ` +
        `prompt_eval=${d.prompt_eval_duration ?? 'n/a'} eval=${d.eval_duration ?? 'n/a'}`,
    );

    return data.message.content;
  }
}

/** Resolve the model from an explicit override, else from configuration. */
function resolveModel(override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const classifier = loadConfig().classifier;
  // Prefer the Modelfile-derived model at runtime; fall back to the pulled
  // base model when no derived model is configured.
  return classifier.derived_model && classifier.derived_model.length > 0
    ? classifier.derived_model
    : classifier.model;
}

/** True when the model is a Modelfile-derived classifier (static SYSTEM block). */
export function isDerivedClassifierModel(model: string): boolean {
  return model === DERIVED_CLASSIFIER_MODEL || model.endsWith('-classifier');
}

/**
 * Default log sink for the classifier's latency instrumentation.
 *
 * IMPORTANT: this must write to STDERR, not stdout. When the classifier runs
 * inside a VS Code Copilot Chat hook, the hook's stdout is read by VS Code and
 * parsed as a single JSON response. Any non-JSON line on stdout (e.g. this
 * latency diagnostic) breaks that parse, so VS Code discards the whole hook
 * output — including the injected `additionalContext` — and the classification
 * never reaches the model. Diagnostics belong on stderr.
 */
function defaultLog(line: string): void {
  console.error(line);
}

/** Resolve the timeout — explicit override, else config, else the default. */
function resolveTimeoutMs(override?: number): number {
  if (override !== undefined && override > 0) {
    return override;
  }
  const fromConfig = loadConfig().classifier.timeout_ms;
  return fromConfig > 0 ? fromConfig : DEFAULT_CLASSIFIER_TIMEOUT_MS;
}

/** Resolve the keep_alive from configuration. */
function resolveKeepAlive(): string {
  return loadConfig().classifier.keep_alive;
}

/** Convenience function — constructs an {@link OllamaClassifier} and classifies. */
export function classify(
  taskText: string,
  options: ClassifierOptions = {},
): Promise<Classification> {
  return new OllamaClassifier(options).classify(taskText);
}

/** Convenience function — assess whether gathered context is sufficient. */
export function assess(
  taskText: string,
  inventoryText: string,
  options: ClassifierOptions = {},
): Promise<ContextAssessment> {
  return new OllamaClassifier(options).assess(taskText, inventoryText);
}

// Re-export so callers can distinguish "unavailable" from "invalid output"
// without importing from the schema module directly.
export { ClassificationValidationError };
