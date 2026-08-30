import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index';
import Mustache from 'mustache';
import {
  CLASSIFICATION_JSON_SCHEMA,
  Classification,
  ClassificationValidationError,
  PROCEDURE_EXTRACTION_JSON_SCHEMA,
  TOOL_NAMES,
  parseClassification,
  parseContextAssessment,
  parseProcedureExtraction,
  type ContextAssessment,
  type ProcedureExtraction,
} from './schema';

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 30_000;

/** How long the model is kept loaded between calls (Ollama keep_alive). */
export const DEFAULT_KEEP_ALIVE = '30m';

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

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Live LLM trace sink (design doc §7). When provided, the classifier streams
 * the model's output and emits start/token/complete events so the dashboard can
 * render the reasoning live. Optional — callers that don't pass one get the
 * original non-streaming behaviour unchanged.
 */
export interface TraceSink {
  /** Emitted before the model call. */
  start(info: { id: string; model: string; request: string }): void;
  /** Emitted per streamed delta. */
  token(info: { id: string; delta: string }): void;
  /** Emitted after the model call (the non-streaming fallback emits this too). */
  complete(info: { id: string; usage?: LlmUsage }): void;
}

export interface ClassifierOptions {
  /** Overrides the configured `classifier.model`. */
  model?: string;
  /** Overrides `OLLAMA_HOST` / the default localhost host. */
  host?: string;
  timeoutMs?: number;
  /** Latency/metrics log sink. Defaults to console.log. */
  log?: (line: string) => void;
  /** Optional LLM trace sink (dashboard live streaming). */
  trace?: TraceSink;
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

const PROCEDURE_EXTRACTION_SHAPE = `{
  "is_procedural": false,
  "trigger_pattern": "",
  "keywords": [],
  "steps": [],
  "confidence": 0.1
}`;

/** Build the procedure-extraction prompt (task 45 mining Step 1.4). */
export function buildExtractPrompt(conversationText: string): string {
  return [
    'You are mining a historical coding conversation for a repeatable,',
    'mechanical task (e.g. "stage and commit", "run tests and fix a specific',
    'failure", "scaffold a component from an existing pattern", or a Serena',
    'edit such as replacing/deleting/inserting lines in a file) as opposed to',
    'one-off creative/novel problem-solving. These tasks are executed with the',
    'local tools: LeanCTX (context read/compress), Serena (symbol search and',
    'file edits), RTK (command-output compression).',
    '',
    'Respond with exactly this JSON shape:',
    PROCEDURE_EXTRACTION_SHAPE,
    '',
    'Rules (be CONSERVATIVE — most conversations are NOT procedural):',
    '- The JSON above is ONLY a format reference showing an EMPTY, non-procedural',
    '  result. Never copy its field values — analyze THIS conversation and output',
    '  your own values.',
    '- is_procedural: true ONLY when the conversation shows a clear, repeated,',
    '  mechanical task with concrete, identifiable commands/actions. Default to',
    '  false for one-off problem-solving, planning, debugging, or creative work.',
    '- is_procedural must be false when you cannot identify concrete steps.',
    '- trigger_pattern: a short imperative phrase describing the task; empty',
    '  string when is_procedural is false. NEVER use an error message, a',
    '  file:line reference, a test/method name, or a status note.',
    '- steps: the concrete commands/actions taken; MUST be non-empty when',
    '  is_procedural is true.',
    '- keywords: 2-6 match terms for recognizing this task again.',
    '- confidence: 0..1 for how sure you are. Be honest — low confidence means',
    '  you should lean toward is_procedural false.',
    '- classification/extraction only — do not write code, do not explain.',
    '',
    'Conversation:',
    '"""',
    conversationText,
    '"""',
  ].join('\n');
}

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

export interface WarmUpOptions {
  host?: string;
  /** Model to load (defaults to the configured classifier model). */
  model?: string;
  /** keep_alive for the warm request (defaults to config). */
  keepAlive?: string | number;
  /** Cap for the cold-load warm request (defaults to 5 minutes). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface WarmUpResult {
  /** True when the model loaded successfully. */
  ok: boolean;
  /** Ollama server reachable. */
  available: boolean;
  /** Configured model present on the server. */
  modelReady: boolean;
  latencyMs: number;
  /** Present when !ok. */
  error?: string;
}

/**
 * Force the local model to load so the first real classify call doesn't pay
 * the cold-load latency (which can take minutes on a cold start). Pings the
 * server, verifies the model is present, then issues a tiny throwaway chat
 * request with a generous timeout. Never throws — returns a WarmUpResult.
 */
export async function warmUpOllama(options: WarmUpOptions = {}): Promise<WarmUpResult> {
  const host = options.host ?? process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
  const model = options.model ?? resolveBaseModel();
  const keepAlive = options.keepAlive ?? resolveKeepAlive();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const log = options.log ?? defaultLog;
  const started = Date.now();
  const latency = (): number => Date.now() - started;

  const available = await isOllamaAvailable(host);
  if (!available) {
    const error = `Ollama not reachable at ${host}`;
    log(`[cadet-brainstem] warm-up failed: ${error}`);
    return { ok: false, available: false, modelReady: false, latencyMs: latency(), error };
  }

  const modelReady = await isModelAvailable(model, host);
  if (!modelReady) {
    const error = `model "${model}" not present on ${host}`;
    log(`[cadet-brainstem] warm-up failed: ${error}`);
    return { ok: false, available: true, modelReady: false, latencyMs: latency(), error };
  }

  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        think: false,
        keep_alive: keepAlive,
        options: { temperature: 0, num_predict: 1 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const error = `warm request returned HTTP ${response.status} for model ${model}`;
      log(`[cadet-brainstem] warm-up failed: ${error}`);
      return { ok: false, available: true, modelReady: false, latencyMs: latency(), error };
    }
    log(`[cadet-brainstem] warm-up complete (${latency()}ms) model=${model}`);
    return { ok: true, available: true, modelReady: true, latencyMs: latency() };
  } catch (err) {
    const error = `warm request failed: ${(err as Error).message}`;
    log(`[cadet-brainstem] warm-up failed: ${error}`);
    return { ok: false, available: true, modelReady: false, latencyMs: latency(), error };
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
  readonly keepAlive: string | number;
  readonly log: (line: string) => void;
  readonly trace: TraceSink | undefined;
  private lastUsage: LlmUsage | undefined;

  constructor(options: ClassifierOptions = {}) {
    this.model = resolveModel(options.model);
    this.host =
      options.host !== undefined && options.host.length > 0
        ? options.host
        : (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
    this.timeoutMs = options.timeoutMs ?? resolveTimeoutMs();
    this.keepAlive = resolveKeepAlive();
    this.log = options.log ?? defaultLog;
    this.trace = options.trace;
  }

  async isAvailable(): Promise<boolean> {
    return isOllamaAvailable(this.host);
  }

  async classify(taskText: string): Promise<Classification> {
    // Always send the full prompt template with the field defs (there is no
    // derived fast-classifier model anymore).
    const prompt = buildPrompt(taskText);
    // Structured output constrains enum values, so the model emits valid
    // classification fields.
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

  /** Extract whether a conversation contains a repeatable procedure (mining). */
  async extractProcedure(conversationText: string): Promise<ProcedureExtraction> {
    return parseProcedureExtraction(
      await this.chatJson(buildExtractPrompt(conversationText), PROCEDURE_EXTRACTION_JSON_SCHEMA),
    );
  }

  /** One chat round-trip returning the model's JSON text content. */
  private async chatJson(
    prompt: string,
    format: unknown = 'json',
  ): Promise<string> {
    const baseBody = {
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
      },
    };

    // No trace sink (default) — original non-streaming behaviour.
    if (this.trace === undefined) {
      return this.chatOnce(baseBody);
    }

    // Dashboard trace active — stream deltas live (design §7).
    const id = randomUUID();
    this.trace.start({ id, model: this.model, request: prompt });
    try {
      const content = await this.streamChat({ ...baseBody, stream: true }, id);
      this.trace.complete(
        this.lastUsage !== undefined ? { id, usage: this.lastUsage } : { id },
      );
      return content;
    } catch {
      // Graceful degradation (design §7, degradation.ts): fall back to the
      // non-streaming path and still emit a bracketing complete.
      try {
        const content = await this.chatOnce(baseBody);
        this.trace.complete(
          this.lastUsage !== undefined ? { id, usage: this.lastUsage } : { id },
        );
        return content;
      } catch (fallbackErr) {
        this.trace.complete({ id });
        throw fallbackErr;
      }
    }
  }

  /** Non-streaming /api/chat round-trip (the original path). */
  private async chatOnce(body: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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

  /**
   * Streaming /api/chat (NDJSON deltas). Emits `llm.trace.token` per delta and
   * accumulates the full content. Throws on any failure so the caller can fall
   * back to the non-streaming path.
   */
  private async streamChat(
    body: Record<string, unknown>,
    id: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ClassifierUnavailableError(
        `Could not reach Ollama at ${this.host}: ${(err as Error).message}`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new ClassifierUnavailableError(
        `Ollama responded with HTTP ${response.status} at ${this.host}`,
      );
    }

    let accumulated = '';
    let usage: LlmUsage | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          let data: {
            message?: { content?: string };
            prompt_eval_count?: number;
            eval_count?: number;
          };
          try {
            data = JSON.parse(trimmed);
          } catch {
            continue; // skip malformed frames
          }
          if (
            typeof data.prompt_eval_count === 'number' ||
            typeof data.eval_count === 'number'
          ) {
            usage = {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            };
          }
          const delta = data.message?.content ?? '';
          if (delta.length > 0) {
            accumulated += delta;
            this.trace?.token({ id, delta });
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }

    if (accumulated.length === 0) {
      throw new ClassifierUnavailableError('Ollama returned no message content');
    }
    this.lastUsage = usage;
    return accumulated;
  }
}

/** Resolve the model from an explicit override, else from configuration. */
function resolveModel(override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const classifier = loadConfig().classifier;
  return classifier.model;
}

/** Resolve the classifier model (plain model; no derived fast-classifier). */
export function resolveBaseModel(): string {
  return loadConfig().classifier.model;
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

/**
 * Resolve the keep_alive from configuration. Ollama accepts either a number
 * (seconds, or -1 for indefinite) or a duration string WITH a unit (e.g.
 * "30m"). A bare numeric STRING like "-1" has no unit and is rejected with
 * HTTP 400 ("time: missing unit in duration "-1""), so coerce numeric strings
 * to numbers.
 */
function resolveKeepAlive(): string | number {
  const raw = loadConfig().classifier.keep_alive;
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return raw;
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

/** Convenience function — extract a repeatable procedure from a conversation. */
export function extractProcedure(
  conversationText: string,
  options: ClassifierOptions = {},
): Promise<ProcedureExtraction> {
  return new OllamaClassifier({
    ...options,
    model: options.model ?? resolveBaseModel(),
  }).extractProcedure(conversationText);
}

// Re-export so callers can distinguish "unavailable" from "invalid output"
// without importing from the schema module directly.
export { ClassificationValidationError };
