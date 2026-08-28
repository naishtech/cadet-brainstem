import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pkg from '../../package.json';
import {
  classifyWithFallback,
  synthesizePlans,
  synthesizeToolPlan,
  type ClassificationOutcome,
} from '../classifier';
import {
  RESPONSE_POLICY_DIRECTIVES,
  assessWithFallback,
  type ContextAssessmentOutcome,
  type EvidencePlan,
  type LanguageStandard,
  type RecommendedTool,
  type Reminder,
  type ResponsePolicy,
  type RetrievalPlan,
  type TaskType,
  type ToolName,
  type ToolPlan,
} from '../classifier';
import type { Classification } from '../classifier';
import { PolicyEngine } from '../policy';
import type { OptimisationStrategy } from '../policy';
import { LeanCtxAdapter } from '../integrations/leanctx';
import { RtkAdapter } from '../integrations/rtk';
import { SerenaAdapter } from '../integrations/serena';
import {
  getDefaultMetricsPath,
  MetricsStore,
  type OptimisationEvent,
  type RequestEvent,
} from '../metrics';
import { loadConfig, saveConfig } from '../config';
import {
  MemoryStore,
  getProjectMemoryPath,
  resolveMemoryDbPath,
  resolveProjectId,
  resolveProjectRootFor,
  type Memory,
} from '../memory';

/** Stable session id stamped on events recorded by MCP tool calls. */
export const MCP_SESSION_ID = 'mcp';

export interface CompiledResponsePolicy {
  directives: Record<string, string>;
  language_standard?: LanguageStandard;
}

/**
 * Compile the response policy into the cloud LLM's directive descriptions plus
 * any categorical choice (e.g. `language_standard`). The classifier picks the
 * subset per request; this returns only those, described for the cloud LLM.
 */
export function compileResponsePolicy(policy: ResponsePolicy): CompiledResponsePolicy {
  const directives: Record<string, string> = {};
  for (const key of policy.directives) {
    directives[key] = RESPONSE_POLICY_DIRECTIVES[key];
  }
  const result: CompiledResponsePolicy = { directives };
  if (policy.language_standard !== undefined) {
    result.language_standard = policy.language_standard;
  }
  return result;
}

export type CoreClassification = Pick<
  Classification,
  'task' | 'complexity' | 'risk' | 'context_need' | 'precision'
> & {
  confidence?: number;
  needs_more_context?: boolean;
};

/** Project a classification to its core fields plus the new confidence signals. */
export function coreClassification(
  classification: Classification,
): CoreClassification {
  const core: CoreClassification = {
    task: classification.task,
    complexity: classification.complexity,
    risk: classification.risk,
    context_need: classification.context_need,
    precision: classification.precision,
  };
  if (classification.confidence !== undefined) {
    core.confidence = classification.confidence;
  }
  if (classification.needs_more_context !== undefined) {
    core.needs_more_context = classification.needs_more_context;
  }
  return core;
}

/** Surface the retrieval plan (queries + scope) as a plain object, or null. */
export function compileRetrieval(
  retrieval: RetrievalPlan | undefined,
): { queries: string[]; scope?: string } | null {
  if (retrieval === undefined || retrieval.queries.length === 0) {
    return null;
  }
  return retrieval.scope !== undefined
    ? { queries: retrieval.queries, scope: retrieval.scope }
    : { queries: retrieval.queries };
}

export interface CompiledToolPlan {
  recommended_tools: RecommendedTool[];
  skip?: ToolName[];
}

/** Compile the tool plan to its canonical form (recommended_tools + skip). */
export function compileToolPlan(plan: ToolPlan | undefined): CompiledToolPlan {
  const result: CompiledToolPlan = {
    recommended_tools: plan?.recommended_tools ?? [],
  };
  if (plan?.skip !== undefined && plan.skip.length > 0) {
    result.skip = plan.skip;
  }
  return result;
}

/** True when the tool plan recommends a given tool (canonical list check). */
function toolPlanUses(plan: ToolPlan | undefined, name: ToolName): boolean {
  return (plan?.recommended_tools ?? []).some((t) => t.name === name);
}

export interface CompiledEvidencePlan {
  prioritized_queries: Array<{
    id: string;
    query: string;
    reason?: string;
    sources: string[];
    cost_estimate?: string;
    fallback?: string[];
  }>;
  scope?: string;
}

/**
 * Surface the prioritized, source-tagged evidence plan. Prefers the new
 * `evidence_plan`; falls back to the legacy `retrieval` alias (transition).
 */
export function compileEvidencePlan(
  evidencePlan: EvidencePlan | undefined,
  retrieval: RetrievalPlan | undefined,
): CompiledEvidencePlan | null {
  const plan =
    evidencePlan ??
    (retrieval !== undefined
      ? {
          prioritized_queries: retrieval.queries.map((query, i) => ({
            id: `q${i + 1}`,
            query,
            sources: ['serena', 'file_search'],
            cost_estimate: 'cheap',
          })),
          ...(retrieval.scope !== undefined ? { scope: retrieval.scope } : {}),
        }
      : undefined);
  if (plan === undefined) {
    return null;
  }
  const result: CompiledEvidencePlan = {
    prioritized_queries: plan.prioritized_queries,
  };
  if (plan.scope !== undefined) {
    result.scope = plan.scope;
  }
  return result;
}

/** A one-line advisory; from guidance, else the first reminder, else synthesized. */
export function compileGuidance(
  classification: Classification,
  task: string,
): string {
  if (classification.guidance !== undefined && classification.guidance.trim().length > 0) {
    return classification.guidance;
  }
  const firstReminder = classification.reminders?.[0]?.message;
  if (firstReminder !== undefined && firstReminder.trim().length > 0) {
    return firstReminder;
  }
  const subject = task.trim().length > 0 ? task.trim() : 'unspecified task';
  return `Advisory: classify and route this request (${subject}); verify facts against the project before concluding.`;
}

/** Tool-anchored reminders the cloud LLM should honor (replaces guidance). */
export function compileReminders(classification: Classification): Reminder[] {
  return classification.reminders ?? [];
}

/** Additional distinct task types detected (multi-task); undefined if none. */
export function compileSubtasks(classification: Classification): TaskType[] | undefined {
  return classification.subtasks;
}

/** Memory hints: advisory use flag, never instructs to skip memory. */
export function compileMemoryHints(classification: Classification): {
  use: boolean | 'if_necessary';
  reason?: string;
} {
  return classification.memory ?? { use: false };
}

/**
 * Memory policy the agent must parse and follow. Memory is *optional evidence,
 * never authoritative state* — the agent retrieves hints and verifies them
 * against the current project before acting.
 */
export const MEMORY_POLICY =
  'Memory is optional evidence, never authoritative state. Retrieve hints before work ' +
  'and verify them against the current project state; store facts that are expensive to ' +
  'rediscover (decisions, constraints, verified commands, gotchas). Never store secrets.';

/** Policy when the tool plan skips memory: don't even check it. */
/** Pick the memory-policy text based on whether the tool plan uses memory. */
export function memoryPolicyFor(usesMemory: boolean | 'if_necessary' | undefined): string {
  if (usesMemory === 'if_necessary')
    return 'Check memory if it helps: consult `chat_memory_store` when it may reduce work, but verify retrieved facts before acting.';
  // Default: memory is optional evidence (never authoritative). Do not suggest skipping memory.
  return MEMORY_POLICY;
}

export interface SerenaTools {
  search: SerenaAdapter['search'];
  callTool: SerenaAdapter['callTool'];
  listTools: SerenaAdapter['listTools'];
  close: () => Promise<void>;
}

export interface LeanCtxTools {
  optimize: LeanCtxAdapter['optimize'];
  callTool: LeanCtxAdapter['callTool'];
  listTools: LeanCtxAdapter['listTools'];
  close: () => Promise<void>;
}

export interface McpDeps {
  classify?: (taskText: string) => Promise<ClassificationOutcome>;
  getStrategy?: (classification: Classification) => OptimisationStrategy;
  /** Context assessment (assess_context); defaults to assessWithFallback. */
  assess?: (
    taskText: string,
    inventoryText: string,
  ) => Promise<ContextAssessmentOutcome>;
  leanctx?: Partial<LeanCtxTools>;
  rtk?: Pick<RtkAdapter, 'optimize'>;
  serena?: Partial<SerenaTools>;
  metricsPath?: string;
  /** Injectable memory store; defaults to a live MemoryStore when omitted. */
  memory?: MemoryStore;
  /** Default project scope for memory operations (defaults to cwd-derived). */
  defaultProject?: string;
  record?: (event: OptimisationEvent) => void;
  log?: (line: string) => void;
}

interface ResolvedDeps {
  classify: (taskText: string) => Promise<ClassificationOutcome>;
  getStrategy: (classification: Classification) => OptimisationStrategy;
  assess: (
    taskText: string,
    inventoryText: string,
  ) => Promise<ContextAssessmentOutcome>;
  leanctx: Partial<LeanCtxTools>;
  rtk: Pick<RtkAdapter, 'optimize'>;
  serena: Partial<SerenaTools>;
  metricsPath: string;
  defaultProject: string;
  record: (event: OptimisationEvent) => void;
  log: (line: string) => void;
}

/** Best-effort metrics recording — a failure never fails the tool call. */
function defaultRecorder(metricsPath: string): (event: OptimisationEvent) => void {
  return (event) => {
    try {
      const store = new MetricsStore(metricsPath);
      store.record(event);
      store.close();
    } catch (err) {
      console.error(
        `[cadet-token-saver] metrics record skipped: ${(err as Error).message}`,
      );
    }
  };
}

/**
 * Shared, process-lifetime adapter singletons. Each MCP tool call goes through
 * `resolveDeps`, which previously constructed a fresh `new SerenaAdapter()` (and
 * LeanCtx/RTK) on every call. Because `SerenaAdapter` holds its MCP session in an
 * instance field, a fresh adapter meant a fresh `serena start-mcp-server` process
 * (and dashboard popup) per call. These singletons make the connection persist
 * across calls: first use starts the process, subsequent calls reuse it.
 */
const sharedSerena = new SerenaAdapter();
const sharedLeanctx = new LeanCtxAdapter();
const sharedRtk = new RtkAdapter();

function resolveDeps(deps: McpDeps = {}): ResolvedDeps {
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();
  return {
    classify: deps.classify ?? classifyWithFallback,
    getStrategy:
      deps.getStrategy ??
      ((classification) => new PolicyEngine().getStrategy(classification)),
    assess: deps.assess ?? assessWithFallback,
    leanctx: deps.leanctx ?? sharedLeanctx,
    rtk: deps.rtk ?? sharedRtk,
    serena: deps.serena ?? sharedSerena,
    metricsPath,
    defaultProject: deps.defaultProject ?? resolveProjectId(process.cwd()),
    record: deps.record ?? defaultRecorder(metricsPath),
    log: deps.log ?? ((line: string) => console.error(line)),
  };
}

// ── Tool handlers (pure, unit-testable) ───────────────────────────────────

/** Reuse a caller-supplied request id, or mint one. */
function resolveRequestId(provided: string | undefined): string {
  return provided !== undefined && provided.length > 0 ? provided : randomUUID();
}

export interface OptimizeContextArgs {
  task: string;
  target: string;
  lines?: string;
  request_id?: string;
}

/**
 * Record a classifier (local-LLM) call. Every outcome is recorded — degraded
 * ones are marked `degraded: true` so the fallback rate is visible; the "real
 * calls" counter filters them out (see `getCallsByTool`).
 */
function recordClassifierCall(
  record: (event: OptimisationEvent) => void,
  outcome: ClassificationOutcome,
  taskText: string,
  requestId: string,
  latencyMs: number,
): void {
  // tool_plan is now synthesized deterministically (the model only classifies
  // + extracts entities), so derive the recommended-tool metric from synthesis.
  const recommended = (synthesizeToolPlan(outcome.classification).recommended_tools ?? []).map(
    (tool) => tool.name,
  );
  record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: outcome.classification.task,
    complexity: outcome.classification.complexity,
    risk: outcome.classification.risk,
    tool: 'ollama',
    operation: 'classify',
    origin: 'mcp',
    estimated_input_tokens: Math.round(Buffer.byteLength(taskText) / 4) + 50,
    estimated_output_tokens: 25,
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: outcome.degraded,
    latency_ms: latencyMs,
    request_id: requestId,
    ...(recommended.length > 0 ? { recommended_tools: recommended } : {}),
  });
}

/** `optimize_context` — classify, pick a LeanCTX mode from the policy, compile. */
export async function optimizeContextTool(
  args: OptimizeContextArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.task !== 'string' || args.task.length === 0) {
    throw new Error('optimize_context requires a non-empty string "task"');
  }
  if (typeof args.target !== 'string' || args.target.length === 0) {
    throw new Error('optimize_context requires a non-empty string "target"');
  }
  const d = resolveDeps(deps);
  const requestId = resolveRequestId(args.request_id);
  const classifyStart = performance.now();
  const outcome = await d.classify(args.task);
  const classifyLatencyMs = Math.round(performance.now() - classifyStart);
  const strategy = d.getStrategy(outcome.classification);
  recordClassifierCall(d.record, outcome, args.task, requestId, classifyLatencyMs);
  if (d.leanctx.optimize === undefined) {
    throw new Error('optimize_context requires a LeanCTX optimize adapter');
  }
  const leanStart = performance.now();
  const result = await d.leanctx.optimize({
    target: args.target,
    mode: strategy.leanctx_mode,
    taskType: outcome.classification.task,
    ...(args.lines !== undefined ? { lines: String(args.lines) } : {}),
  });
  const leanLatencyMs = Math.round(performance.now() - leanStart);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: outcome.classification.task,
    complexity: outcome.classification.complexity,
    risk: outcome.classification.risk,
    tool: 'leanctx',
    operation: 'optimize_context',
    estimated_input_tokens: Math.round(result.sourceSize / 4),
    estimated_output_tokens: Math.round(result.returnedSize / 4),
    estimated_tokens_saved: result.estimatedTokensSaved,
    compression_ratio:
      result.sourceSize > 0 ? result.returnedSize / result.sourceSize : null,
    optimisation_strategy: strategy.leanctx_mode,
    degraded: result.degraded,
    latency_ms: leanLatencyMs,
    request_id: requestId,
  });
  const note =
    result.estimatedTokensSaved === 0 && !result.degraded
      ? 'no compression benefit from LeanCTX on this target'
      : undefined;

  const classification = synthesizePlans(outcome.classification);
  return {
    // Token-saving steering fields first so the cloud LLM reads them first.
    response_policy: compileResponsePolicy(classification.response_policy),
    reminders: compileReminders(classification),
    tool_plan: compileToolPlan(classification.tool_plan),
    classification: coreClassification(classification),
    entities: classification.entities,
    strategy,
    guidance: compileGuidance(classification, args.task),
    ...(compileSubtasks(classification) !== undefined
      ? { subtasks: compileSubtasks(classification) }
      : {}),
    evidence_plan: compileEvidencePlan(classification.evidence_plan, classification.retrieval),
    retrieval: compileRetrieval(classification.retrieval),
    context: result.context,
    mode: result.mode,
    sourceSize: result.sourceSize,
    returnedSize: result.returnedSize,
    estimatedTokensSaved: result.estimatedTokensSaved,
    degraded: result.degraded,
    request_id: requestId,
    memory_hints: compileMemoryHints(classification),
    memory_policy: memoryPolicyFor(
      classification.memory?.use ??
        toolPlanUses(classification.tool_plan, 'chat_memory_store'),
    ),
    ...(note !== undefined ? { note } : {}),
  };
}

export interface ClassifyArgs {
  task: string;
  request_id?: string;
}

/** `classify` — classify a task with the local LLM, pick the strategy. */
export async function classifyTool(
  args: ClassifyArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.task !== 'string' || args.task.length === 0) {
    throw new Error('classify requires a non-empty string "task"');
  }
  const d = resolveDeps(deps);
  // Quick, inexpensive memory lookup: if the project-scoped memory DB contains
  // matching memories for this task, surface them as an auto-generated plan
  // placed into the `tasks/` directory. This is intentionally shallow (simple
  // substring search) to keep the classifier stateless and fast.
  let relevant_memories: Array<Record<string, unknown>> | undefined = undefined;
  try {
    const store =
      deps.memory ??
      new MemoryStore(
        resolveMemoryDbPath(
          process.cwd(),
          undefined,
          loadConfig().memory.active_project,
          loadConfig().memory.projects,
        ),
      );
    try {
      const memories = store.search({ query: args.task, project: d.defaultProject }) as Memory[];
      if (Array.isArray(memories) && memories.length > 0) {
        const max = Math.min(5, memories.length);
        relevant_memories = [];
        for (const m of memories.slice(0, max)) {
          if (!m) continue;
          const content = m.content ?? '';
          const snippet = (String(content).split('\n')[0] ?? '').slice(0, 200);
          relevant_memories.push({ id: m.id, snippet, tags: m.tags, project: m.project });
        }
      }
    } finally {
      if (deps.memory === undefined) {
        try {
          store.close();
        } catch (e) {
          void e;
        }
      }
    }
  } catch (err) {
    d.log(`memory lookup skipped: ${(err as Error).message}`);
  }
  const requestId = resolveRequestId(args.request_id);
  const classifyStart = performance.now();
  const outcome = await d.classify(args.task);
  const classifyLatencyMs = Math.round(performance.now() - classifyStart);
  // The model only classifies + extracts entities; synthesize the token-saving
  // fields (tool_plan / evidence_plan / response_policy / reminders) in code.
  const classification = synthesizePlans(outcome.classification);
  const strategy = d.getStrategy(outcome.classification);
  recordClassifierCall(d.record, outcome, args.task, requestId, classifyLatencyMs);
  return {
    // Token-saving steering fields first so the cloud LLM reads them first.
    response_policy: compileResponsePolicy(classification.response_policy),
    reminders: compileReminders(classification),
    tool_plan: compileToolPlan(classification.tool_plan),
    classification: coreClassification(classification),
    entities: classification.entities,
    strategy,
    guidance: compileGuidance(classification, args.task),
    ...(compileSubtasks(classification) !== undefined
      ? { subtasks: compileSubtasks(classification) }
      : {}),
    evidence_plan: compileEvidencePlan(classification.evidence_plan, classification.retrieval),
    retrieval: compileRetrieval(classification.retrieval),
    memory_hints: compileMemoryHints(classification),
    memory_policy: memoryPolicyFor(
      classification.memory?.use ?? toolPlanUses(classification.tool_plan, 'chat_memory_store'),
    ),
    degraded: outcome.degraded,
    ...(relevant_memories !== undefined ? { relevant_memories } : {}),
    request_id: requestId,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

export interface ChatMemoryArgs {
  action: string;
  content?: string;
  id?: string;
  query?: string;
  tags?: string[];
  project?: string;
  limit?: number;
  request_id?: string;
}

const MEMORY_ACTIONS = new Set([
  'store',
  'update',
  'get',
  'search',
  'list',
  'delete',
]);

/** Validate chat_memory_store arguments; throws so invalid input is an MCP error. */
function validateMemoryAction(action: string, args: ChatMemoryArgs): void {
  switch (action) {
    case 'store':
      if (typeof args.content !== 'string' || args.content.length === 0) {
        throw new Error('store requires a non-empty string "content"');
      }
      break;
    case 'update':
    case 'get':
    case 'delete':
      if (typeof args.id !== 'string' || args.id.length === 0) {
        throw new Error(`${action} requires a non-empty string "id"`);
      }
      break;
  }
  if (
    args.tags !== undefined &&
    (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== 'string'))
  ) {
    throw new Error('"tags" must be an array of strings');
  }
  if (args.project !== undefined && typeof args.project !== 'string') {
    throw new Error('"project" must be a string');
  }
  if (args.query !== undefined && typeof args.query !== 'string') {
    throw new Error('"query" must be a string');
  }
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' || !Number.isFinite(args.limit))
  ) {
    throw new Error('"limit" must be a finite number');
  }
}

/** Dispatch a validated action to the store (arguments are already validated). */
function executeMemoryAction(
  store: MemoryStore,
  action: string,
  args: ChatMemoryArgs,
): unknown {
  switch (action) {
    case 'store':
      return {
        id: store.store({
          content: args.content!,
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.project !== undefined ? { project: args.project } : {}),
        }),
      };
    case 'update':
      return {
        updated: store.update(args.id!, {
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
        }),
      };
    case 'get':
      return store.get(args.id!);
    case 'search':
      return store.search({
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.project !== undefined ? { project: args.project } : {}),
      });
    case 'list':
      return store.list({
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    case 'delete':
      return { deleted: store.delete(args.id!) };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/** Record a chat_memory_store metrics event (best-effort via deps.record). */
function recordMemoryCall(
  record: (event: OptimisationEvent) => void,
  operation: string,
  requestId: string,
  latencyMs: number,
  degraded: boolean,
): void {
  record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'memory',
    complexity: 'low',
    risk: 'low',
    tool: 'memory',
    operation,
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded,
    latency_ms: latencyMs,
    request_id: requestId,
  });
}

/**
 * `chat_memory_store` — create/update/retrieve/delete agent memories (local
 * SQLite, design doc §17). Fails gracefully (degraded result, never throws)
 * when the store is unavailable; invalid arguments throw as MCP errors.
 */
export async function chatMemoryStoreTool(
  args: ChatMemoryArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  const action = args.action;
  if (typeof action !== 'string' || !MEMORY_ACTIONS.has(action)) {
    throw new Error(
      `chat_memory_store requires a valid "action" (one of: ${[...MEMORY_ACTIONS].join(', ')})`,
    );
  }
  validateMemoryAction(action, args);
  const d = resolveDeps(deps);
  const ownsStore = deps.memory === undefined;
  const store =
    deps.memory ??
    new MemoryStore(
      resolveMemoryDbPath(
        process.cwd(),
        args.project,
        loadConfig().memory.active_project,
        loadConfig().memory.projects,
      ),
    );
  const requestId = resolveRequestId(args.request_id);
  const start = performance.now();
  try {
    const effectiveArgs: ChatMemoryArgs = {
      ...args,
      project: args.project ?? d.defaultProject,
    };
    const result = executeMemoryAction(store, action, effectiveArgs);
    recordMemoryCall(
      d.record,
      action,
      requestId,
      Math.round(performance.now() - start),
      false,
    );
    return { action, result, request_id: requestId, memory_policy: MEMORY_POLICY };
  } catch (err) {
    recordMemoryCall(
      d.record,
      action,
      requestId,
      Math.round(performance.now() - start),
      true,
    );
    return {
      action,
      degraded: true,
      error: (err as Error).message,
      request_id: requestId,
      memory_policy: MEMORY_POLICY,
    };
  } finally {
    if (ownsStore) {
      store.close();
    }
  }
}

export interface ActivateProjectArgs {
  project: string;
}

/**
 * `activate_project` — set the active project for memory (Serena-style).
 * Accepts a project path or a registered project name; resolves it to a root
 * and persists it so subsequent memory ops default to that project.
 */
export async function activateProjectTool(
  args: ActivateProjectArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.project !== 'string' || args.project.length === 0) {
    throw new Error('activate_project requires a non-empty string "project"');
  }
  const cwd = process.cwd();
  const root = resolveProjectRootFor(
    args.project,
    cwd,
    loadConfig().memory.projects,
  );
  const config = loadConfig();
  saveConfig({ ...config, memory: { ...config.memory, active_project: root } });
  return {
    project: resolveProjectId(root),
    root,
    memory_db: getProjectMemoryPath(root),
  };
}

export interface FindSymbolsArgs {
  query: string;
  cwd: string;
  project?: string;
  request_id?: string;
}

/** `find_relevant_symbols` — Serena semantic search for targeted context. */
export async function findRelevantSymbolsTool(
  args: FindSymbolsArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.query !== 'string' || args.query.length === 0) {
    throw new Error('find_relevant_symbols requires a non-empty string "query"');
  }
  if (typeof args.cwd !== 'string' || args.cwd.length === 0) {
    throw new Error('find_relevant_symbols requires a non-empty string "cwd"');
  }
  const d = resolveDeps(deps);
  if (d.serena.search === undefined) {
    return { degraded: true, error: 'serena search unavailable' };
  }
  const requestId = resolveRequestId(args.request_id);
  const searchStart = performance.now();
  const result = await d.serena.search({
    query: args.query,
    cwd: args.cwd,
    ...(args.project !== undefined ? { project: String(args.project) } : {}),
  });
  const searchLatencyMs = Math.round(performance.now() - searchStart);
  const textBytes = Buffer.byteLength(result.rawText);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'search',
    complexity: 'low',
    risk: 'low',
    tool: 'serena',
    operation: 'find_relevant_symbols',
    estimated_input_tokens: Math.round(textBytes / 4),
    estimated_output_tokens: Math.round(textBytes / 4),
    estimated_tokens_saved: 0,
    compression_ratio: 1,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: searchLatencyMs,
    symbols_found: result.symbols.length,
    files_found: result.files.length,
    request_id: requestId,
  });
  return {
    query: result.query,
    symbols: result.symbols,
    files: result.files,
    rawText: result.rawText,
    degraded: result.degraded,
    request_id: requestId,
  };
}

export interface CompressOutputArgs {
  command: string;
  cwd?: string;
  shell?: string;
  request_id?: string;
}

export interface SerenaCallArgs {
  tool: string;
  arguments?: Record<string, unknown>;
  cwd?: string;
  project?: string;
  request_id?: string;
}

/** `serena_call` — forward any call to any Serena tool (generic passthrough). */
export async function serenaCallTool(
  args: SerenaCallArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.tool !== 'string' || args.tool.length === 0) {
    throw new Error('serena_call requires a non-empty string "tool"');
  }
  const d = resolveDeps(deps);
  if (d.serena.callTool === undefined) {
    return { degraded: true, error: 'serena passthrough unavailable' };
  }
  const requestId = resolveRequestId(args.request_id);
  const callStart = performance.now();
  const result = await d.serena.callTool({
    tool: args.tool,
    ...(args.arguments !== undefined ? { arguments: args.arguments } : {}),
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
    ...(args.project !== undefined ? { project: String(args.project) } : {}),
  });
  const callLatencyMs = Math.round(performance.now() - callStart);
  const textBytes = Buffer.byteLength(result.rawText);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'search',
    complexity: 'low',
    risk: 'low',
    tool: 'serena',
    operation: args.tool,
    estimated_input_tokens: Math.round(
      Buffer.byteLength(JSON.stringify(args.arguments ?? {})) / 4,
    ),
    estimated_output_tokens: Math.round(textBytes / 4),
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: callLatencyMs,
    request_id: requestId,
  });
  return {
    tool: result.tool,
    result: result.result,
    degraded: result.degraded,
    request_id: requestId,
  };
}

export interface SerenaListArgs {
  cwd?: string;
  project?: string;
  request_id?: string;
}

/** `serena_list_tools` — list what Serena currently exposes (discovery). */
export async function serenaListToolsTool(
  args: SerenaListArgs = {},
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  const d = resolveDeps(deps);
  if (d.serena.listTools === undefined) {
    return { tools: [], degraded: true, error: 'serena passthrough unavailable' };
  }
  const requestId = resolveRequestId(args.request_id);
  const callStart = performance.now();
  const result = await d.serena.listTools({
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
    ...(args.project !== undefined ? { project: String(args.project) } : {}),
  });
  const callLatencyMs = Math.round(performance.now() - callStart);
  const textBytes = Buffer.byteLength(
    JSON.stringify(result.tools.map((t) => t.name)),
  );
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'search',
    complexity: 'low',
    risk: 'low',
    tool: 'serena',
    operation: 'list_tools',
    estimated_input_tokens: 0,
    estimated_output_tokens: Math.round(textBytes / 4),
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: callLatencyMs,
    request_id: requestId,
  });
  return {
    tools: result.tools.map((t) => t.name),
    degraded: result.degraded,
    request_id: requestId,
  };
}

export interface LeanCtxCallArgs {
  /** LeanCTX tool name, e.g. ctx_read, ctx_shell, ctx_search, ctx_explore. */
  tool: string;
  /** Arguments forwarded verbatim to the LeanCTX tool. */
  arguments?: Record<string, unknown>;
  /** Project directory (defaults to the server cwd). */
  cwd?: string;
  request_id?: string;
}

/** `leanctx_call` — forward any call to any `ctx_*` tool over MCP. */
export async function leanctxCallTool(
  args: LeanCtxCallArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.tool !== 'string' || args.tool.length === 0) {
    throw new Error('leanctx_call requires a non-empty string "tool"');
  }
  const d = resolveDeps(deps);
  if (d.leanctx.callTool === undefined) {
    return { degraded: true, error: 'leanctx passthrough unavailable' };
  }
  const requestId = resolveRequestId(args.request_id);
  const callStart = performance.now();
  const result = await d.leanctx.callTool({
    tool: args.tool,
    ...(args.arguments !== undefined ? { arguments: args.arguments } : {}),
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
  });
  const callLatencyMs = Math.round(performance.now() - callStart);
  const textBytes = Buffer.byteLength(result.rawText);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'search',
    complexity: 'low',
    risk: 'low',
    tool: 'leanctx',
    operation: args.tool,
    estimated_input_tokens: Math.round(
      Buffer.byteLength(JSON.stringify(args.arguments ?? {})) / 4,
    ),
    estimated_output_tokens: Math.round(textBytes / 4),
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: callLatencyMs,
    request_id: requestId,
  });
  return {
    tool: result.tool,
    result: result.result,
    degraded: result.degraded,
    request_id: requestId,
  };
}

export interface LeanCtxListArgs {
  cwd?: string;
  request_id?: string;
}

/** `leanctx_list_tools` — list what LeanCTX currently exposes (discovery). */
export async function leanctxListToolsTool(
  args: LeanCtxListArgs = {},
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  const d = resolveDeps(deps);
  if (d.leanctx.listTools === undefined) {
    return { tools: [], degraded: true, error: 'leanctx passthrough unavailable' };
  }
  const requestId = resolveRequestId(args.request_id);
  const callStart = performance.now();
  const result = await d.leanctx.listTools({
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
  });
  const callLatencyMs = Math.round(performance.now() - callStart);
  const textBytes = Buffer.byteLength(
    JSON.stringify(result.tools.map((t) => t.name)),
  );
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'search',
    complexity: 'low',
    risk: 'low',
    tool: 'leanctx',
    operation: 'list_tools',
    estimated_input_tokens: 0,
    estimated_output_tokens: Math.round(textBytes / 4),
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: callLatencyMs,
    request_id: requestId,
  });
  return {
    tools: result.tools.map((t) => t.name),
    degraded: result.degraded,
    request_id: requestId,
  };
}

/**
 * `compress_command_output` — run a read-only command and return its
 * RTK-reduced output. The full raw output is never sent back (that is the
 * point); its size is reported so savings are measurable. The command is
 * passed through as-is to the platform shell (cmd.exe on Windows) unless a
 * `shell` is given (e.g. "bash" for git-bash).
 */
export async function compressCommandOutputTool(
  args: CompressOutputArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error(
      'compress_command_output requires a non-empty string "command"',
    );
  }
  const d = resolveDeps(deps);
  const requestId = resolveRequestId(args.request_id);
  const rtkStart = performance.now();
  const result = await d.rtk.optimize({
    command: args.command,
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
    ...(args.shell !== undefined ? { shell: String(args.shell) } : {}),
  });
  const rtkLatencyMs = Math.round(performance.now() - rtkStart);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'investigation',
    complexity: 'low',
    risk: 'low',
    tool: 'rtk',
    operation: 'compress_command_output',
    estimated_input_tokens: result.estimatedTokensBefore,
    estimated_output_tokens: result.estimatedTokensAfter,
    estimated_tokens_saved: result.estimatedTokensSaved,
    compression_ratio:
      result.rawOutputSize > 0
        ? result.optimisedOutputSize / result.rawOutputSize
        : null,
    optimisation_strategy: null,
    degraded: result.degraded,
    latency_ms: rtkLatencyMs,
    request_id: requestId,
  });
  const note =
    result.estimatedTokensSaved === 0 && !result.degraded
      ? 'nothing to compress — output is small or already compact (0 tokens saved)'
      : undefined;
  return {
    command: result.command,
    optimisedOutput: result.optimisedOutput,
    rawOutputSize: result.rawOutputSize,
    optimisedOutputSize: result.optimisedOutputSize,
    estimatedTokensBefore: result.estimatedTokensBefore,
    estimatedTokensAfter: result.estimatedTokensAfter,
    estimatedTokensSaved: result.estimatedTokensSaved,
    degraded: result.degraded,
    request_id: requestId,
    ...(note !== undefined ? { note } : {}),
  };
}

export interface AssessContextArgs {
  request_id: string;
  task?: string;
}

/** Compact inventory text fed to the controller (≤ a few hundred tokens). */
function formatInventory(
  task: string,
  requestId: string,
  events: RequestEvent[],
): string {
  if (events.length === 0) {
    return `Task: ${task}\nrequest ${requestId}: nothing gathered yet.`;
  }
  const lines = events.map((event) => {
    const detail =
      event.symbolsFound !== null
        ? `${event.symbolsFound} symbols, ${event.filesFound ?? 0} files`
        : `${event.estimatedInputTokens}->${event.estimatedOutputTokens} tokens`;
    return `- ${event.operation} (${event.tool})${event.degraded ? ' [degraded]' : ''}: ${detail}`;
  });
  return `Task: ${task}\nrequest ${requestId} gathered:\n${lines.join('\n')}`;
}

function summarizeEvent(event: RequestEvent): Record<string, unknown> {
  return {
    tool: event.tool,
    operation: event.operation,
    estimatedInputTokens: event.estimatedInputTokens,
    estimatedOutputTokens: event.estimatedOutputTokens,
    symbolsFound: event.symbolsFound,
    filesFound: event.filesFound,
    degraded: event.degraded,
  };
}

/**
 * `assess_context` — stateless controller step. Rebuilds the context inventory
 * for a request_id from MetricsStore, then asks the local LLM whether the
 * gathered signal is sufficient (verdict) and what to gather next (tool_plan).
 */
export async function assessContextTool(
  args: AssessContextArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.request_id !== 'string' || args.request_id.length === 0) {
    throw new Error('assess_context requires a non-empty string "request_id"');
  }
  const d = resolveDeps(deps);
  const requestId = args.request_id;
  const task = args.task ?? 'the current task';

  let inventory: RequestEvent[] = [];
  try {
    const store = new MetricsStore(d.metricsPath);
    inventory = store.getEventsByRequestId(requestId);
    store.close();
  } catch {
    // metrics unavailable — proceed with an empty inventory
  }

  const inventoryText = formatInventory(task, requestId, inventory);
  const start = performance.now();
  const outcome = await d.assess(task, inventoryText);
  const latencyMs = Math.round(performance.now() - start);

  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: 'investigation',
    complexity: 'low',
    risk: 'low',
    tool: 'ollama',
    operation: 'assess_context',
    estimated_input_tokens: Math.round(Buffer.byteLength(inventoryText) / 4) + 50,
    estimated_output_tokens: 25,
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: outcome.degraded,
    latency_ms: latencyMs,
    request_id: requestId,
  });

  return {
    request_id: requestId,
    verdict: outcome.assessment.verdict,
    tool_plan: outcome.assessment.tool_plan,
    reason: outcome.assessment.reason,
    degraded: outcome.degraded,
    inventory: inventory.map(summarizeEvent),
  };
}

// ── Tool registry + MCP server wiring ─────────────────────────────────────

const TOOL_DEFS = [
  {
    name: 'classify',
    description:
      'Classify the user request with the local LLM and return the recommended ' +
      'optimisation strategy (LeanCTX mode, compression, search approach), a ' +
      'tool_plan (tools to use/skip) and a response_policy (directives to follow ' +
      'when replying). Call this first on the user request before using the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user request / task to classify.',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'optimize_context',
    description:
      'Classify a task, then return the LeanCTX-compressed representation of a file/directory as context. ' +
      'Use this instead of reading a large file raw, or to expand/triage shell/command output before ' +
      'sending it to the model.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task description used to classify and pick the LeanCTX mode.',
        },
        target: {
          type: 'string',
          description: 'File or directory path to compile.',
        },
        lines: {
          type: 'string',
          description: 'Optional line range for the lines mode, e.g. "10-50".',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['task', 'target'],
    },
  },
  {
    name: 'find_relevant_symbols',
    description:
      'Find symbols relevant to a query using Serena semantic search. Returns symbols and files ' +
      'so you can read only the relevant context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name / path pattern to find.',
        },
        cwd: {
          type: 'string',
          description: 'Project directory.',
        },
        project: {
          type: 'string',
          description: 'Optional Serena project name/path (defaults to cwd).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['query', 'cwd'],
    },
  },
  {
    name: 'serena_call',
    description:
      'Call any tool exposed by the Serena MCP server (symbol search, referencing ' +
      'symbols, rename, diagnostics, etc.) by forwarding the request. Use ' +
      'serena_list_tools to see what Serena currently exposes; for a typed symbol ' +
      'search prefer find_relevant_symbols.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Serena tool name, e.g. find_symbol, find_referencing_symbols, rename_symbol.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments forwarded verbatim to the Serena tool.',
        },
        cwd: {
          type: 'string',
          description: 'Project directory (defaults to the server cwd).',
        },
        project: {
          type: 'string',
          description: 'Optional Serena project name/path (defaults to cwd).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'serena_list_tools',
    description:
      'List the tools currently exposed by the Serena MCP server (names + schemas) ' +
      'so the agent can call any of them via serena_call without hardcoding.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Project directory (defaults to the server cwd).',
        },
        project: {
          type: 'string',
          description: 'Optional Serena project name/path (defaults to cwd).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
    },
  },
  {
    name: 'leanctx_call',
    description:
      'Call any tool exposed by the LeanCTX MCP server (ctx_read, ctx_shell, ' +
      'ctx_search, ctx_explore, ctx_callgraph, ctx_knowledge, ctx_gain, etc.) by ' +
      'forwarding the request. Use leanctx_list_tools to see what LeanCTX exposes; ' +
      'for a policy-driven file compile prefer optimize_context.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description:
            'LeanCTX tool name, e.g. ctx_read, ctx_shell, ctx_search, ctx_explore, ctx_callgraph, ctx_gain.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments forwarded verbatim to the LeanCTX tool.',
        },
        cwd: {
          type: 'string',
          description: 'Project directory (defaults to the server cwd).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'leanctx_list_tools',
    description:
      'List the tools currently exposed by the LeanCTX MCP server (names + schemas) ' +
      'so the agent can call any of them via leanctx_call without hardcoding.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Project directory (defaults to the server cwd).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
    },
  },
  {
    name: 'compress_command_output',
    description:
      'Run a read-only command and return its RTK-compressed output. Only helps on noisy/large ' +
      'output (git status, ls, tests). On Windows commands run in cmd by default — pass '
      + '"shell": "bash" to use git-bash. The command is passed through as-is.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Read-only command to run, e.g. "git status".',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory.',
        },
        shell: {
          type: 'string',
          description:
            'Shell to run the command in (defaults to the platform shell, cmd.exe on Windows; pass "bash" for git-bash).',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'chat_memory_store',
    description:
      'Persist and retrieve agent memories in a local SQLite store. Use action ' +
      'store/update/get/search/list/delete. Check memory before starting work and ' +
      'store facts that are expensive to rediscover (decisions, constraints, ' +
      'verified commands, gotchas). Never store secrets or credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['store', 'update', 'get', 'search', 'list', 'delete'],
          description: 'The memory operation to perform.',
        },
        content: {
          type: 'string',
          description: 'Memory content (required for store; optional for update).',
        },
        id: {
          type: 'string',
          description: 'Memory id (required for update/get/delete).',
        },
        query: {
          type: 'string',
          description: 'Substring to match against content (search).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to scope search or attach to a memory.',
        },
        project: {
          type: 'string',
          description: 'Optional project scope.',
        },
        limit: {
          type: 'number',
          description: 'Optional max results for list.',
        },
        request_id: {
          type: 'string',
          description: 'Optional shared id linking this call to a logical flow.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'activate_project',
    description:
      'Set the active project for memory storage (like Serena). Accepts a project path or a registered project name; subsequent chat_memory_store calls default to that project. "__global__" is reserved for cross-project facts.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project path or registered name to activate.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'assess_context',
    description:
      'Assess whether the context gathered so far for a request_id is sufficient, using the local LLM. Returns verdict (continue|stop), a next tool_plan, and a reason. Call between context-gathering tools to close the loop.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The shared request id returned by classify / previous tool calls.',
        },
        task: {
          type: 'string',
          description: 'Optional task description (defaults to a generic one).',
        },
      },
      required: ['request_id'],
    },
  },
];

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Dispatch a tool call by name — the wiring `createMcpServer` uses. */
export async function handleToolCall(
  name: string,
  rawArgs: unknown,
  deps: McpDeps = {},
): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    let result: Record<string, unknown>;
    switch (name) {
      case 'classify':
        result = await classifyTool(args as unknown as ClassifyArgs, deps);
        break;
      case 'optimize_context':
        result = await optimizeContextTool(
          args as unknown as OptimizeContextArgs,
          deps,
        );
        break;
      case 'find_relevant_symbols':
        result = await findRelevantSymbolsTool(
          args as unknown as FindSymbolsArgs,
          deps,
        );
        break;
      case 'serena_call':
        result = await serenaCallTool(args as unknown as SerenaCallArgs, deps);
        break;
      case 'serena_list_tools':
        result = await serenaListToolsTool(args as unknown as SerenaListArgs, deps);
        break;
      case 'leanctx_call':
        result = await leanctxCallTool(args as unknown as LeanCtxCallArgs, deps);
        break;
      case 'leanctx_list_tools':
        result = await leanctxListToolsTool(
          args as unknown as LeanCtxListArgs,
          deps,
        );
        break;
      case 'compress_command_output':
        result = await compressCommandOutputTool(
          args as unknown as CompressOutputArgs,
          deps,
        );
        break;
      case 'chat_memory_store':
        result = await chatMemoryStoreTool(
          args as unknown as ChatMemoryArgs,
          deps,
        );
        break;
      case 'assess_context':
        result = await assessContextTool(
          args as unknown as AssessContextArgs,
          deps,
        );
        break;
      case 'activate_project':
        result = await activateProjectTool(
          args as unknown as ActivateProjectArgs,
        );
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

/** Build the stdio MCP server exposing the engine as tools (design doc §16). */
export function createMcpServer(deps: McpDeps = {}): Server {
  const server = new Server(
    { name: 'cadet-token-saver', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    return handleToolCall(name, rawArgs, deps);
  });

  return server;
}

/** Run the MCP server over stdio; resolves when the client disconnects. */
export async function runMcpServer(deps: McpDeps = {}): Promise<number> {
  const resolved = resolveDeps(deps);
  const server = createMcpServer(resolved);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Client disconnected — release the persistent Serena session (if any).
  await resolved.serena.close?.().catch(() => undefined);
  return 0;
}
