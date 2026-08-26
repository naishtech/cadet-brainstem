import { loadConfig } from '../config/index';
import {
  Classification,
  ClassificationValidationError,
  RESPONSE_POLICY_DIRECTIVES,
  TOOL_NAMES,
  parseClassification,
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
  "tool_plan": { "use": ["<tool>", "<tool>"], "skip": ["<tool>", "<tool>"] },
  "response_policy": ["<directive>", "<directive>"]
}`;

/** Build the classifier prompt. It instructs the model to classify ONLY. */
export function buildPrompt(taskText: string): string {
  const tools = TOOL_NAMES.join(', ');
  const directives = (
    Object.keys(RESPONSE_POLICY_DIRECTIVES) as ResponsePolicyKey[]
  )
    .map((key) => `- ${key}: ${RESPONSE_POLICY_DIRECTIVES[key]}`)
    .join('\n');
  return [
    'You are a task classifier for an AI coding agent context optimizer.',
    'Classify the user request ONLY.',
    'Rules:',
    '- classify only; do not solve, answer, or explain the request',
    '- return JSON only, with no commentary and no markdown fences',
    '- do not invent information; base the classification solely on the request',
    '- when uncertain, prefer the conservative option (higher context_need, normal precision)',
    '',
    `Respond with exactly this JSON shape:\n${CLASSIFICATION_SHAPE}`,
    '',
    `tool_plan: recommend the context tools to use and to skip, from: ${tools}.`,
    'Only recommend a tool when it clearly helps this request; be aggressive with skip.',
    '',
    'response_policy: pick the directives the agent should follow when replying.',
    'Be aggressive: a simple single-action request (e.g. "merge the PR") needs only',
    'a minimal set (delta_only, no_filler, no_tool_narration). A research-heavy',
    'request should include preserve_evidence and progressive_disclosure.',
    directives,
    '',
    'User request:',
    '"""',
    taskText,
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
    let response: Response;
    try {
      response = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: buildPrompt(taskText) }],
          stream: false,
          format: 'json',
          // Disable qwen3 reasoning/thinking — we only need a classification,
          // so thinking wastes tokens and latency.
          think: false,
          // Keep the model warm between calls so a cold reload (which can take
          // ~10s on CPU) doesn't blow the timeout on the next classify.
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

    return parseClassification(data.message.content);
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

// Re-export so callers can distinguish "unavailable" from "invalid output"
// without importing from the schema module directly.
export { ClassificationValidationError };
