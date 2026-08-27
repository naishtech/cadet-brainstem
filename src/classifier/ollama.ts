import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/index';
import Mustache from 'mustache';
import {
  Classification,
  ClassificationValidationError,
  LANGUAGE_STANDARD_DESCRIPTIONS,
  LANGUAGE_STANDARDS,
  RESPONSE_POLICY_DIRECTIVES,
  TOOL_NAMES,
  parseClassification,
  parseContextAssessment,
  type ContextAssessment,
  type LanguageStandard,
  type ResponsePolicyKey,
} from './schema';

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 30_000;

/** How long the model is kept loaded between calls (Ollama keep_alive). */
export const DEFAULT_KEEP_ALIVE = '30m';

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
}

const CLASSIFICATION_SHAPE = `{
  "task": "question | coding_new | coding_fix | debug | refactor | test | review | architecture | documentation | investigation | planning | search | configuration",
  "complexity": "low | medium | high",
  "risk": "low | medium | high",
  "context_need": "minimal | targeted | broad | exhaustive",
  "precision": "approximate | normal | exact",
  "guidance": "<one advisory sentence>",
  "tool_plan": { "use": ["<tool>"], "recommended_tools": [{ "name": "<tool>", "intent": "<why>", "priority": 1 }] },
  "response_policy": { "directives": ["<directive>", "<directive>"], "language_standard": "asd_ste100 | microsoft | google | diataxis | iso_24495 | ieee" },
  "evidence_plan": { "prioritized_queries": [{ "id": "q1", "query": "<search term>", "sources": ["serena", "file_search"], "cost_estimate": "cheap" }], "scope": "<initial scope>" },
  "memory": { "use": true },
  "confidence": 0.0,
  "needs_more_context": false
}`;

const DEFAULT_CLASSIFIER_PROMPT_TEMPLATE = `You are a task classifier for an AI coding agent context optimizer.
Classify the user request ONLY.
Rules:
- classify only; do not solve, answer, or explain the request
- return JSON only, with no commentary and no markdown fences
- do not invent information; base the classification solely on the request
- when uncertain, prefer the conservative option (higher context_need, normal precision)

Respond with exactly this JSON shape:
{{{classificationShape}}}

task: "review" is for reviewing existing code, changes, or a PR.
Do not use "review" for design, planning, architecture, or exploratory requests.
For requests that ask to design, plan, investigate, or explore an approach, prefer
"investigation" or "planning" instead of "review".

context_need: size it to THIS request. A narrow question about one convention
or area is "targeted"; reserve "broad"/"exhaustive" for tasks that genuinely
need the whole repository.

tool_plan: recommend the context tools to use from: {{{tools}}}.
Only recommend a tool when it clearly helps this request. Pair each tool in
"use" with a "recommended_tools" entry { "name", "intent", "priority" }
(1-based, cheapest-first).
Shell/command output routing: when a task runs shell/CLI commands with noisy or
large output, offer BOTH compress_command_output (RTK - fast, moderate) and
leanctx_call with ctx_shell (LeanCTX - aggressive compression, slower, may
drop detail) so the downstream agent can choose.

response_policy: an object the CLOUD LLM must follow when composing its reply.
Shape: { "directives": [<directive>, ...], "language_standard": "<one>|omit" }.
"directives": pick the directives the agent should follow. Be aggressive: a
simple single-action request (e.g. "merge the PR") needs only a minimal set
(delta_only, no_filler, no_tool_narration). A research-heavy request should
include preserve_evidence and progressive_disclosure. {{{directives}}}
"language_standard": optional; pick ONE recommended documentation language
standard for the request's expected output from:
{{{languageStandards}}}
Omit language_standard only if no standard clearly applies.

guidance: ONE short advisory sentence describing how to approach the request
(e.g. compare/search/summarize focus). Concise, actionable, non-authoritative.

evidence_plan: the prioritized, source-tagged retrieval plan. Shape:
{ "prioritized_queries": [{ "id", "query", "sources", "cost_estimate", "fallback" }], "scope" }.
List specific search terms (identifiers, file/dir names, config keys) cheapest-first.
"sources" are hint labels (serena, rtk, file_search, leanctx) — the orchestrator
executes each. Omit when no search is needed. "retrieval" {queries, scope} is a
legacy alias still accepted.

memory: OPTIONAL { "use": true | false | "if_necessary", "reason" }.
"use" may never be "skip"; prefer recommending memory when it may help.

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
  const tools = TOOL_NAMES.join(', ');
  const directives = (
    Object.keys(RESPONSE_POLICY_DIRECTIVES) as ResponsePolicyKey[]
  )
    .map((key) => `- ${key}: ${RESPONSE_POLICY_DIRECTIVES[key]}`)
    .join('\n');
  const languageStandards = (LANGUAGE_STANDARDS as readonly LanguageStandard[])
    .map((key) => `- ${LANGUAGE_STANDARD_DESCRIPTIONS[key]}`)
    .join('\n');

  const promptTemplate = template ?? loadClassifierPromptTemplate();
  return Mustache.render(promptTemplate, {
    classificationShape: CLASSIFICATION_SHAPE,
    tools,
    directives,
    languageStandards,
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

  constructor(options: ClassifierOptions = {}) {
    this.model = resolveModel(options.model);
    this.host =
      options.host !== undefined && options.host.length > 0
        ? options.host
        : (process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);
    this.timeoutMs = options.timeoutMs ?? resolveTimeoutMs();
    this.keepAlive = resolveKeepAlive();
  }

  async isAvailable(): Promise<boolean> {
    return isOllamaAvailable(this.host);
  }

  async classify(taskText: string): Promise<Classification> {
    return parseClassification(await this.chatJson(buildPrompt(taskText)));
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
  private async chatJson(prompt: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          format: 'json',
          // Disable qwen3 reasoning/thinking — we only need a short structured
          // decision, so thinking wastes tokens and latency.
          think: false,
          // Keep the model warm between calls so a cold reload (which can take
          // ~10s on CPU) doesn't blow the timeout.
          keep_alive: this.keepAlive,
          options: { temperature: 0 },
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

    return data.message.content;
  }
}

/** Resolve the model from an explicit override, else from configuration. */
function resolveModel(override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return loadConfig().classifier.model;
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
