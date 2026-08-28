import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getDefaultMetricsPath, MetricsStore } from '../../metrics';
import {
  getDefaultMemoryPath,
  MemoryStore,
  resolveProjectRoot,
} from '../../memory';
import { DEFAULT_RECOMMENDED_TOOL } from './hooks';
import {
  classifyWithFallback,
  isModelAvailable,
  synthesizePlans,
  type Classification,
} from '../../classifier';
import { loadConfig } from '../../config';
import { createFastClassifierCli } from '../../core/installers';
import type { CliCommand } from '../types';

/**
 * Shared VS Code Copilot Chat Hooks payload. VS Code passes a JSON object on
 * stdin with a `hook_event_name`, `session_id`, `cwd` and event-specific
 * fields (e.g. `tool_name`/`tool_input` for Pre/PostToolUse, `prompt` for
 * UserPromptSubmit).
 */
export interface HookPayload {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  model_id?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_output?: string;
  toolOutput?: string;
  prompt?: string;
  request?: string;
}

export interface HookLifecycleDeps {
  /** Override stdin reader (tests). */
  readStdin?: () => Promise<string>;
  /** Override stdout writer (tests). */
  writeOut?: (line: string) => void;
  /** Override the state directory (tests). */
  stateDir?: string;
  /** Override metrics db path (tests). */
  metricsPath?: string;
  /** Override memory db path (tests). */
  memoryPath?: string;
  /** Override the project resolver (tests). */
  resolveProject?: (cwd: string) => string;
  /** Override the classifier (tests). Defaults to classifyWithFallback. */
  classify?: (text: string) => Promise<{
    classification: Classification;
    degraded: boolean;
  }>;
  /**
   * Enable/disable the automatic derived-classifier build on SessionStart.
   * Defaults to config `classifier.auto_build` (true). Set false in tests to
   * skip the build (and the config read).
   */
  autoBuild?: boolean;
  /** Override the Ollama model-presence check (tests). Defaults to isModelAvailable. */
  classifierAvailable?: (model: string, host?: string) => Promise<boolean>;
  /** Override the classifier build (tests). Defaults to createFastClassifierCli. */
  buildClassifier?: (base: string, host?: string) => Promise<{ ok: boolean; error?: string }>;
}

/** The output envelope VS Code Copilot Chat Hooks accept on stdout. */
export interface LifecycleOutput {
  hookSpecificOutput?: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    additionalContext?: string;
    hookEventName?: string;
  };
  continue?: boolean;
  systemMessage?: string;
}

/** Read and parse the hook payload from stdin. Returns null on empty/invalid. */
export async function readPayload(
  deps: HookLifecycleDeps = {},
): Promise<HookPayload | null> {
  const readStdin = deps.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  });
  const raw = (await readStdin()).trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return null;
  }
}

function writeOut(deps: HookLifecycleDeps, output: LifecycleOutput): void {
  const w = deps.writeOut ?? ((line: string) => process.stdout.write(line));
  w(JSON.stringify(output));
}

function projectFor(
  payload: HookPayload,
  deps: HookLifecycleDeps = {},
): string {
  const cwd = payload.cwd ?? payload.cwd ?? process.cwd();
  if (deps.resolveProject) {
    return deps.resolveProject(cwd);
  }
  return resolveProjectRoot(cwd);
}

/** Record a metrics event (best-effort — never breaks the hook). */
export function recordMetrics(
  deps: HookLifecycleDeps,
  event: {
    sessionId: string;
    tool: string;
    operation: string;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedTokensSaved: number;
    /** Origin of the recorded call; defaults to 'hook' (all hook-lifecycle events). */
    origin?: string;
  },
): void {
  try {
    const store = new MetricsStore(deps.metricsPath ?? getDefaultMetricsPath());
    store.record({
      timestamp: new Date().toISOString(),
      session_id: event.sessionId,
      task_type: 'investigation',
      complexity: 'low',
      risk: 'low',
      tool: event.tool,
      operation: event.operation,
      origin: event.origin ?? 'hook',
      estimated_input_tokens: event.estimatedInputTokens,
      estimated_output_tokens: event.estimatedOutputTokens,
      estimated_tokens_saved: event.estimatedTokensSaved,
      compression_ratio: null,
      optimisation_strategy: null,
    });
    store.close();
  } catch {
    // best-effort
  }
}

/** Store a memory entry (best-effort). */
export function storeMemory(
  deps: HookLifecycleDeps,
  content: string,
  tags: string[],
  project: string,
): void {
  try {
    const store = new MemoryStore(deps.memoryPath ?? getDefaultMemoryPath());
    store.store({ content, tags, project });
    store.close();
  } catch {
    // best-effort
  }
}

/** Search memory for session-relevant hints (best-effort). */
export function searchMemory(
  deps: HookLifecycleDeps,
  project: string,
  query?: string,
  limit = 5,
): string[] {
  try {
    const store = new MemoryStore(deps.memoryPath ?? getDefaultMemoryPath());
    const results = store.list({ project, limit });
    const matched =
      query === undefined || query.length === 0
        ? results
        : results.filter((m) =>
            m.content.toLowerCase().includes(query.toLowerCase()),
          );
    store.close();
    return matched.map((m) => m.content);
  } catch {
    return [];
  }
}

function stateDirFor(deps: HookLifecycleDeps): string {
  return (
    deps.stateDir ??
    join(os.homedir(), '.local', 'state', 'cadet-brainstem', 'hooks')
  );
}

/** Remove persisted hook state for a session (Stop cleanup). */
export function cleanupSessionState(
  sessionId: string,
  deps: HookLifecycleDeps = {},
): void {
  try {
    const dir = join(stateDirFor(deps), sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    const file = join(stateDirFor(deps), `${sessionId}.json`);
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * Auto-build the Modelfile-derived classifier on SessionStart if it is missing
 * and the base model is present. Best-effort and guarded: never throws, never
 * prompts, and skips when the derived model already exists, the base model is
 * absent, or `classifier.auto_build` is false. Builds via `createFastClassifierCli`
 * (the `ollama create` CLI / docker), which bakes the SYSTEM block and verifies
 * it — never the broken HTTP `/api/create` path that silently drops SYSTEM.
 */
export async function autoBuildClassifier(
  deps: HookLifecycleDeps = {},
): Promise<void> {
  try {
    const enabled = deps.autoBuild ?? loadConfig().classifier.auto_build;
    if (!enabled) {
      return;
    }
    const cfg = loadConfig().classifier;
    const derived = cfg.derived_model ?? cfg.model;
    const base = cfg.model;
    const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    const isAvailable = deps.classifierAvailable ?? isModelAvailable;
    if (await isAvailable(derived, host)) {
      return; // already present
    }
    if (!(await isAvailable(base, host))) {
      return; // cannot build without the base model
    }
    const build = deps.buildClassifier ?? createFastClassifierCli;
    await build(base, host);
  } catch {
    // best-effort — never break the session-start hook
  }
}

/**
 * SessionStart handler: prime the session by injecting a compact primer with
 * memory hints + the recommended tool, so the agent doesn't re-discover state.
 * Also auto-builds the derived classifier if missing (best-effort, ~seconds).
 */
export async function runHookSessionStart(
  deps: HookLifecycleDeps = {},
  recommendedTool = DEFAULT_RECOMMENDED_TOOL,
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const project = projectFor(payload, deps);
  const hints = searchMemory(deps, project, 'session context', 5);

  await autoBuildClassifier(deps);

  let primer = `Session start. Recommended tool: ${recommendedTool}. `;
  primer += `Prefer it over raw grep/read for code-centric exploration.`;
  if (hints.length > 0) {
    primer += `\nRelevant memory:\n${hints.map((h) => `- ${h}`).join('\n')}`;
  }

  writeOut(deps, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: primer,
    },
    continue: true,
  });
  recordMetrics(deps, {
    sessionId,
    tool: 'hook',
    operation: 'session_start',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  return 0;
}

/**
 * UserPromptSubmit handler: classify the prompt with the local model and inject
 * the returned strategy (response_policy + tool_plan + guidance) as context, so
 * the downstream LM deterministically follows the cheap path.
 */
export async function runHookUserPrompt(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const prompt = payload.prompt ?? payload.request ?? '';
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';

  if (!prompt.trim()) {
    writeOut(deps, { continue: true });
    return 0;
  }

  const { classification, degraded } = await (deps.classify ??
    classifyWithFallback)(prompt);
  // The model only classifies + extracts entities; synthesize the steering
  // fields (tool_plan / response_policy) in code for the injected context.
  const synthesized = synthesizePlans(classification);
  const tools = (synthesized.tool_plan?.recommended_tools ?? [])
    .map((t) => t.name)
    .join(', ');
  const directives = (synthesized.response_policy?.directives ?? []).join(', ');
  const entities = (synthesized.entities ?? []).join(', ');

  let ctx = `Classified request. Follow the response_policy and tool plan.\n`;
  ctx += `- task: ${synthesized.task ?? ''}\n`;
  ctx += `- entities: ${entities || '(none)'}\n`;
  ctx += `- recommended tools: ${tools || '(none)'}\n`;
  ctx += `- response_policy directives: ${directives || '(none)'}\n`;
  ctx += `- language_standard: ${synthesized.response_policy?.language_standard ?? '(none)'}\n`;
  if (classification.guidance) {
    ctx += `- guidance: ${classification.guidance}\n`;
  }
  if (degraded) {
    ctx += `- (classifier degraded — conservative defaults applied)\n`;
  }

  writeOut(deps, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: ctx,
    },
    continue: true,
  });
  recordMetrics(deps, {
    sessionId,
    tool: 'classify',
    operation: 'user_prompt',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  return 0;
}

/**
 * PostToolUse handler: record token-saving metrics per tool call. Best-effort,
 * emits no extra context (avoid adding tokens).
 */
export async function runHookPostTool(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const toolName = payload.tool_name ?? payload.toolName ?? 'tool';
  const output = payload.tool_output ?? payload.toolOutput ?? '';
  const outputBytes = output.length;
  // Rough token estimate: ~4 chars per token.
  const estimatedOutputTokens = Math.round(outputBytes / 4);

  recordMetrics(deps, {
    sessionId,
    tool: toolName,
    operation: 'post_tool_use',
    estimatedInputTokens: 0,
    estimatedOutputTokens,
    estimatedTokensSaved: 0,
  });
  writeOut(deps, { continue: true });
  return 0;
}

/**
 * PreCompact handler: export important context to memory before truncation so
 * nothing is lost, and remind the agent to preserve evidence.
 */
export async function runHookPreCompact(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const project = projectFor(payload, deps);

  storeMemory(
    deps,
    `Pre-compact checkpoint for session ${sessionId} (${new Date().toISOString()}): ` +
      'preserve decisions, constraints, actions, errors and evidence before truncation.',
    ['precompact', sessionId],
    project,
  );

  writeOut(deps, {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext:
        'Conversation is about to be compacted. Before truncation, export any ' +
        'important decisions, constraints, errors and evidence to chat_memory_store ' +
        'so nothing is lost.',
    },
    continue: true,
  });
  recordMetrics(deps, {
    sessionId,
    tool: 'hook',
    operation: 'pre_compact',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  return 0;
}

/**
 * SubagentStart handler: classify the subtask so nested agents use the cheap
 * path, and inject a compact primer.
 */
export async function runHookSubagentStart(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const prompt = payload.prompt ?? payload.request ?? '';

  let ctx = 'Subagent started. Prefer the recommended cadet tools and the cheap path.';
  if (prompt.trim()) {
    const { classification } = await (deps.classify ?? classifyWithFallback)(
      prompt,
    );
    const tools = (classification.tool_plan?.recommended_tools ?? [])
      .map((t) => t.name)
      .join(', ');
    ctx += `\nSubtask classified. Recommended tools: ${tools || '(none)'}.`;
  }

  writeOut(deps, {
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext: ctx,
    },
    continue: true,
  });
  recordMetrics(deps, {
    sessionId,
    tool: 'hook',
    operation: 'subagent_start',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  return 0;
}

/**
 * SubagentStop handler: record nested usage and clean up transient state.
 */
export async function runHookSubagentStop(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';

  recordMetrics(deps, {
    sessionId,
    tool: 'hook',
    operation: 'subagent_stop',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  cleanupSessionState(sessionId, deps);
  writeOut(deps, { continue: true });
  return 0;
}

/**
 * Stop handler: persist a session summary to memory, record metrics, and clean
 * up transient hook state.
 */
export async function runHookStop(
  deps: HookLifecycleDeps = {},
): Promise<number> {
  const payload = await readPayload(deps);
  if (!payload) {
    writeOut(deps, {});
    return 0;
  }
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const project = projectFor(payload, deps);

  storeMemory(
    deps,
    `Session ${sessionId} ended at ${new Date().toISOString()}.`,
    ['session-end', sessionId],
    project,
  );
  recordMetrics(deps, {
    sessionId,
    tool: 'hook',
    operation: 'stop',
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTokensSaved: 0,
  });
  cleanupSessionState(sessionId, deps);
  writeOut(deps, { continue: true });
  return 0;
}

// ── CLI commands ──────────────────────────────────────────────────────────

function lifecycleCommand(
  name: string,
  description: string,
  run: (deps: HookLifecycleDeps) => Promise<number>,
): CliCommand {
  return {
    name,
    description,
    run(): Promise<number> {
      return run({});
    },
  };
}

export const hookSessionStartCommand = lifecycleCommand(
  'hook-session-start',
  'SessionStart hook: prime the session with memory hints + recommended tool',
  runHookSessionStart,
);

export const hookUserPromptCommand = lifecycleCommand(
  'hook-user-prompt',
  'UserPromptSubmit hook: classify the prompt and inject the strategy',
  runHookUserPrompt,
);

export const hookPostToolCommand = lifecycleCommand(
  'hook-post-tool',
  'PostToolUse hook: record token-saving metrics per tool call',
  runHookPostTool,
);

export const hookPreCompactCommand = lifecycleCommand(
  'hook-pre-compact',
  'PreCompact hook: export important context to memory before truncation',
  runHookPreCompact,
);

export const hookSubagentStartCommand = lifecycleCommand(
  'hook-subagent-start',
  'SubagentStart hook: classify the subtask and inject a cheap-path primer',
  runHookSubagentStart,
);

export const hookSubagentStopCommand = lifecycleCommand(
  'hook-subagent-stop',
  'SubagentStop hook: record nested usage and clean up state',
  runHookSubagentStop,
);

export const hookStopCommand = lifecycleCommand(
  'hook-stop',
  'Stop hook: persist session summary, record metrics, clean up state',
  runHookStop,
);
