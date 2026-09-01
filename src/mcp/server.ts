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
  steerWithFallback,
  conservativeDefaultSteering,
  synthesizePlans,
  synthesizeToolPlan,
  type SteeringOutcome,
} from '../steering';
import {
  LlmStatusTracker,
  isOllamaAvailable,
  warmUpOllama,
  type LlmStatus,
} from '../steering';
import {
  RESPONSE_POLICY_DIRECTIVES,
  assessWithFallback,
  type ContextAssessmentOutcome,
  type LanguageStandard,
  type RecommendedTool,
  type Reminder,
  type ResponsePolicy,
  type RetrievalPlan,
  type TaskType,
  type ToolName,
  type ToolPlan,
} from '../steering';
import type { Steering } from '../steering';
import { PolicyEngine } from '../policy';
import type { OptimisationStrategy } from '../policy';
import { LeanCtxAdapter } from '../integrations/leanctx';
import { SerenaAdapter } from '../integrations/serena';
import {
  getDefaultMetricsPath,
  MetricsStore,
  type OptimisationEvent,
  type RequestEvent,
} from '../metrics';
import { loadConfig, saveConfig } from '../config';
import { getInstrumenter, type Instrumenter } from '../dashboard/instrument';
import { getTraceSink } from '../dashboard/trace';
import { startInProcessDashboard } from '../dashboard/auto-start';
import {
  MemoryStore,
  getProjectMemoryPath,
  resolveMemoryDbPath,
  resolveProjectId,
  resolveProjectRootFor,
  type Memory,
} from '../memory';
import {
  buildWriteDiff,
  defaultFillArgs,
  executeProcedure,
  isWriteStep,
  ProcedureStore,
  type Procedure,
  type ProcedureStep,
  FileProcedureReviewState,
  hashProcedureArgs,
  reviewExpiry,
  type ProcedureReviewState,
} from '../procedure';

/** Stable session id stamped on events recorded by MCP tool calls. */
export const MCP_SESSION_ID = 'mcp';

export interface CompiledResponsePolicy {
  directives: Record<string, string>;
  language_standard?: LanguageStandard;
}

/**
 * Compile the response policy into the cloud LLM's directive descriptions plus
 * any categorical choice (e.g. `language_standard`). The steering picks the
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

export type CoreSteering = Pick<
  Steering,
  'task' | 'complexity' | 'risk' | 'context_need' | 'precision'
> & {
  confidence?: number;
  needs_more_context?: boolean;
};

/** Project a steering to its core fields plus the new confidence signals. */
export function coreSteering(
  steering: Steering,
): CoreSteering {
  const core: CoreSteering = {
    task: steering.task,
    complexity: steering.complexity,
    risk: steering.risk,
    context_need: steering.context_need,
    precision: steering.precision,
  };
  if (steering.confidence !== undefined) {
    core.confidence = steering.confidence;
  }
  if (steering.needs_more_context !== undefined) {
    core.needs_more_context = steering.needs_more_context;
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

/** Tool-anchored reminders the cloud LLM should honor (replaces guidance). */
export function compileReminders(steering: Steering): Reminder[] {
  return steering.reminders ?? [];
}

/** Additional distinct task types detected (multi-task); undefined if none. */
export function compileSubtasks(steering: Steering): TaskType[] | undefined {
  return steering.subtasks;
}

/** Memory hints: advisory use flag, never instructs to skip memory. */
export function compileMemoryHints(steering: Steering): {
  use: boolean | 'if_necessary';
  reason?: string;
} {
  return steering.memory ?? { use: false };
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

/**
 * Serialized strategy for the cloud LLM — omits `context_need`, which always
 * duplicates `steering.context_need` (the policy engine copies it).
 */
function serializeStrategy(
  strategy: OptimisationStrategy,
): Omit<OptimisationStrategy, 'context_need'> {
  return {
    compression: strategy.compression,
    code_search: strategy.code_search,
    terminal_output: strategy.terminal_output,
    leanctx_mode: strategy.leanctx_mode,
    ...(strategy.leanctx_budget !== undefined
      ? { leanctx_budget: strategy.leanctx_budget }
      : {}),
  };
}

/** Slim a matched procedure to the handoff fields the cloud LLM needs. */
function slimProcedure(p: Procedure) {
  return {
    id: p.id,
    triggerPattern: p.triggerPattern,
    steps: p.steps,
    riskTier: p.riskTier,
    handoffShape: p.handoffShape,
  };
}

export interface SerenaTools {
  search: SerenaAdapter['search'];
  callTool: SerenaAdapter['callTool'];
  listTools: SerenaAdapter['listTools'];
  close: () => Promise<void>;
}

export interface LeanCtxTools {
  optimize: LeanCtxAdapter['optimize'];
  close: () => Promise<void>;
}

export interface McpDeps {
  steer?: (taskText: string) => Promise<SteeringOutcome>;
  getStrategy?: (steering: Steering) => OptimisationStrategy;
  /** Context assessment (assess_context); defaults to assessWithFallback. */
  assess?: (
    taskText: string,
    inventoryText: string,
  ) => Promise<ContextAssessmentOutcome>;
  leanctx?: Partial<LeanCtxTools>;
  serena?: Partial<SerenaTools>;
  /** Local-LLM availability; drives the fast "warming up / down" degrade path. */
  llmStatus?: LlmStatusTracker;
  metricsPath?: string;
  /** Injectable memory store; defaults to a live MemoryStore when omitted. */
  memory?: MemoryStore;
  /** Default project scope for memory operations (defaults to cwd-derived). */
  defaultProject?: string;
  /** Injectable procedure store; defaults to a live ProcedureStore when omitted. */
  procedureStore?: ProcedureStore;
  /** Injectable arg-filler for procedure_apply (tests); defaults to the local LLM. */
  procedureFillArgs?: (step: ProcedureStep, repo: string) => Promise<Record<string, unknown>>;
  /** Injectable review state; defaults to a short-lived local file store. */
  procedureReviewState?: ProcedureReviewState;
  /** Injectable adapters for procedure_apply (tests); defaults to real ones. */
  procedureSerena?: { callTool(args: unknown): Promise<{ rawText: string; degraded?: boolean }> };
  procedureLeanctx?: { callTool(args: unknown): Promise<{ rawText: string; degraded?: boolean }> };
  /** Stream per-step reasoning during procedure_apply (default true). Tests pass false. */
  procedureThinkEachStep?: boolean;
  record?: (event: OptimisationEvent) => void;
  log?: (line: string) => void;
  /** Dashboard instrumentation (defaults to a config-aware singleton). */
  instrument?: Instrumenter;
}

interface ResolvedDeps {
  steer: (taskText: string) => Promise<SteeringOutcome>;
  getStrategy: (steering: Steering) => OptimisationStrategy;
  assess: (
    taskText: string,
    inventoryText: string,
  ) => Promise<ContextAssessmentOutcome>;
  leanctx: Partial<LeanCtxTools>;
  serena: Partial<SerenaTools>;
  llmStatus: LlmStatusTracker;
  metricsPath: string;
  defaultProject: string;
  record: (event: OptimisationEvent) => void;
  log: (line: string) => void;
  instrument: Instrumenter;
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
        `[cadet-brainstem] metrics record skipped: ${(err as Error).message}`,
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
/** Shared local-LLM availability, reset per MCP server process. */
const sharedLlmStatus = new LlmStatusTracker();

function resolveDeps(deps: McpDeps = {}): ResolvedDeps {
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();
  return {
    steer: deps.steer ??
      ((taskText) => steerWithFallback(taskText, { trace: getTraceSink() })),
    getStrategy:
      deps.getStrategy ??
      ((steering) => new PolicyEngine().getStrategy(steering)),
    assess: deps.assess ?? assessWithFallback,
    leanctx: deps.leanctx ?? sharedLeanctx,
    serena: deps.serena ?? sharedSerena,
    llmStatus: deps.llmStatus ?? sharedLlmStatus,
    metricsPath,
    defaultProject: deps.defaultProject ?? resolveProjectId(process.cwd()),
    record: deps.record ?? defaultRecorder(metricsPath),
    log: deps.log ?? ((line: string) => console.error(line)),
    instrument: deps.instrument ?? getInstrumenter(),
  };
}

// ── Tool handlers (pure, unit-testable) ───────────────────────────────────

/** Reuse a caller-supplied request id, or mint one. */
function resolveRequestId(provided: string | undefined): string {
  return provided !== undefined && provided.length > 0 ? provided : randomUUID();
}

/** Bounded summary hint for dashboard instrumentation (avoids huge SSE frames). */
/**
 * Serialize a tool input/result for the dashboard request/response columns.
 *
 * The cap is deliberately generous: the Instrumenter applies the real
 * truncation policy (`dashboard.captureFull` → 120-char hints when off, full
 * content when on). This upper bound only guards against pathological payloads
 * (e.g. a huge symbol dump) blowing up the in-memory ring buffer / JSONL.
 */
function hintText(value: unknown, max = 100_000): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Build a fast, conservative SteeringOutcome for the given LLM status,
 * with a human-readable reason the cloud LLM can relay to the user.
 */
function conservativeOutcome(status: LlmStatus): SteeringOutcome {
  return {
    steering: structuredClone(conservativeDefaultSteering),
    degraded: true,
    reason:
      status === 'warming'
        ? 'local LLM is warming up — returned conservative defaults; procedures cannot be executed yet'
        : 'local LLM is down — returned conservative defaults; procedures cannot be executed yet',
  };
}

/**
 * Steer, but fail fast to conservative defaults while the local LLM is
 * warming up or down — so the cloud LLM gets a fast response instead of
 * stalling on a cold model load (which can take minutes).
 *
 * When the LLM is marked `down`, re-probes Ollama: if it has come back up
 * (e.g. the container was started / the model was warmed externally), it flips
 * to `warming` and kicks off a warm-up so later calls recover automatically
 * instead of staying degraded forever. This call still returns fast defaults.
 */
function steerOrDegrade(d: ResolvedDeps, task: string): Promise<SteeringOutcome> {
  const status = d.llmStatus.status;
  // `ready` and the transient `unknown` (pre-warm-up / default tracker) call
  // Ollama directly; only `warming`/`down` take the fast-degrade path.
  if (status === 'ready' || status === 'unknown') {
    return d.steer(task);
  }
  if (status === 'warming') {
    return Promise.resolve(conservativeOutcome('warming'));
  }
  // down: Ollama may have come back since the server's warm-up failed. Probe
  // cheaply and recover if it's reachable.
  return isOllamaAvailable().then((available) => {
    if (!available) {
      return conservativeOutcome('down');
    }
    d.llmStatus.set('warming');
    void warmUpOnServerStart(d);
    return conservativeOutcome('warming');
  });
}

export interface OptimizeContextArgs {
  task: string;
  target: string;
  lines?: string;
  request_id?: string;
}

/**
 * Record a steering (local-LLM) call. Every outcome is recorded — degraded
 * ones are marked `degraded: true` so the fallback rate is visible; the "real
 * calls" counter filters them out (see `getCallsByTool`).
 */
function recordSteeringCall(
  record: (event: OptimisationEvent) => void,
  outcome: SteeringOutcome,
  taskText: string,
  requestId: string,
  latencyMs: number,
): void {
  // tool_plan is now synthesized deterministically (the model only classifies
  // + extracts entities), so derive the recommended-tool metric from synthesis.
  const recommended = (synthesizeToolPlan(outcome.steering).recommended_tools ?? []).map(
    (tool) => tool.name,
  );
  record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: outcome.steering.task,
    complexity: outcome.steering.complexity,
    risk: outcome.steering.risk,
    tool: 'ollama',
    operation: 'steering',
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

/** `optimize_context` — steer, pick a LeanCTX mode from the policy, compile. */
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
  const steerStart = performance.now();
  const outcome = await steerOrDegrade(d, args.task);
  const steerLatencyMs = Math.round(performance.now() - steerStart);
  const strategy = d.getStrategy(outcome.steering);
  recordSteeringCall(d.record, outcome, args.task, requestId, steerLatencyMs);
  if (d.leanctx.optimize === undefined) {
    throw new Error('optimize_context requires a LeanCTX optimize adapter');
  }
  const leanStart = performance.now();
  const result = await d.leanctx.optimize({
    target: args.target,
    mode: strategy.leanctx_mode,
    taskType: outcome.steering.task,
    ...(args.lines !== undefined ? { lines: String(args.lines) } : {}),
  });
  const leanLatencyMs = Math.round(performance.now() - leanStart);
  d.record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: outcome.steering.task,
    complexity: outcome.steering.complexity,
    risk: outcome.steering.risk,
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

  const steering = synthesizePlans(outcome.steering);
  const usesMemory =
    steering.memory?.use ??
    toolPlanUses(steering.tool_plan, 'chat_memory_store');
  return {
    // Most important directions first (response_policy -> ... -> request_id).
    response_policy: compileResponsePolicy(steering.response_policy),
    tool_plan: compileToolPlan(steering.tool_plan),
    reminders: compileReminders(steering),
    steering: coreSteering(steering),
    entities: steering.entities,
    strategy: serializeStrategy(strategy),
    memory_hints: compileMemoryHints(steering),
    ...(usesMemory === 'if_necessary'
      ? { memory_policy: memoryPolicyFor(usesMemory) }
      : {}),
    ...(compileSubtasks(steering) !== undefined
      ? { subtasks: compileSubtasks(steering) }
      : {}),
    ...(compileRetrieval(steering.retrieval) !== null
      ? { retrieval: compileRetrieval(steering.retrieval) }
      : {}),
    degraded: result.degraded,
    context: result.context,
    mode: result.mode,
    sourceSize: result.sourceSize,
    returnedSize: result.returnedSize,
    estimatedTokensSaved: result.estimatedTokensSaved,
    ...(note !== undefined ? { note } : {}),
    request_id: requestId,
  };
}

export interface SteerArgs {
  task: string;
  request_id?: string;
}

export interface ProcedureReviewArgs {
  procedure_id: string;
  repo: string;
  step_index?: number;
  args?: Record<string, Record<string, unknown>>;
}

export interface ProcedureApplyArgs {
  procedure_id: string;
  repo: string;
  /** Must be true to apply write steps — this IS the review-gate approval. */
  approved: boolean;
  /** Optional per-tool arg overrides, e.g. { "create_text_file": {...} }. */
  args?: Record<string, Record<string, unknown>>;
  /** Server-issued token returned by procedure_review. */
  review_token?: string;
}

/**
 * `procedure_review` — build a concrete, reviewable diff for the write step(s)
 * of a matched procedure against a real repo, WITHOUT applying anything. The
 * cloud LLM reviews this before approving a write (task 49).
 */
export async function procedureReviewTool(
  args: ProcedureReviewArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.procedure_id !== 'string' || typeof args.repo !== 'string') {
    throw new Error('procedure_review requires string "procedure_id" and "repo"');
  }
  const store = deps.procedureStore ?? new ProcedureStore();
  try {
    const procedure = store.get(args.procedure_id);
    if (procedure === null) {
      return { procedure_id: args.procedure_id, error: `no procedure with id "${args.procedure_id}"` };
    }
    const writeSteps = procedure.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => isWriteStep(s));
    const targets =
      args.step_index !== undefined
        ? writeSteps.filter(({ i }) => i === args.step_index)
        : writeSteps;
    const reviews: Array<Record<string, unknown>> = [];
    const reviewedArgs: Record<string, Record<string, unknown>> = {};
    for (const { s } of targets) {
      try {
        const filled = args.args?.[s.tool] ?? await defaultFillArgs(s, args.repo);
        reviewedArgs[s.tool] = filled;
        const proposal = buildWriteDiff(s, filled, args.repo);
        reviews.push({
          service: s.service,
          tool: s.tool,
          args: filled,
          path: proposal.path,
          kind: proposal.kind,
          unsupported: proposal.unsupported,
          ...(proposal.unsupported ? {} : { diff: proposal.diff, before: proposal.before, after: proposal.after }),
        });
      } catch (err) {
        reviews.push({ service: s.service, tool: s.tool, error: (err as Error).message });
      }
    }
    const result: Record<string, unknown> = {
      procedure_id: args.procedure_id,
      repo: args.repo,
      reviews,
    };
    if (writeSteps.length > 0 && reviews.length === targets.length) {
      const state = deps.procedureReviewState ?? new FileProcedureReviewState();
      const issued = state.issue({
        procedureId: args.procedure_id,
        repo: args.repo,
        argsHash: hashProcedureArgs(reviewedArgs),
        expiresAt: reviewExpiry(),
      });
      result.review_token = issued.token;
      result.expires_at = issued.expiresAt;
      result.reviewed_args = reviewedArgs;
    }
    return result;
  } finally {
    if (deps.procedureStore === undefined) {
      try {
        store.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * `procedure_apply` — approve + apply a reviewed write procedure in-agent. This
 * tool IS the review-gate approval: it refuses unless `approved: true` is
 * passed explicitly. Runs the procedure's steps against the real repo via the
 * execution bridge and records the outcome.
 */
export async function procedureApplyTool(
  args: ProcedureApplyArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.procedure_id !== 'string' || typeof args.repo !== 'string') {
    throw new Error('procedure_apply requires string "procedure_id" and "repo"');
  }
  if (args.approved !== true) {
    return {
      procedure_id: args.procedure_id,
      ok: false,
      code: 'APPROVAL_REQUIRED',
      next_action: 'procedure_review',
      error: 'approved must be true to apply writes (review gate)',
    };
  }
  const store = deps.procedureStore ?? new ProcedureStore();
  try {
    const procedure = store.get(args.procedure_id);
    if (procedure === null) {
      return { procedure_id: args.procedure_id, ok: false, error: `no procedure with id "${args.procedure_id}"` };
    }
    const hasWrites = procedure.steps.some((step) => isWriteStep(step));
    if (hasWrites) {
      if (typeof args.review_token !== 'string' || args.review_token.length === 0) {
        return {
          procedure_id: args.procedure_id,
          ok: false,
          code: 'REVIEW_REQUIRED',
          next_action: 'procedure_review',
          error: 'procedure_review must complete before applying writes',
        };
      }
      const reviewState = deps.procedureReviewState ?? new FileProcedureReviewState();
      const review = reviewState.consume(args.review_token, {
        procedureId: args.procedure_id,
        repo: args.repo,
        argsHash: hashProcedureArgs(args.args),
      });
      if (!review.ok) {
        return {
          procedure_id: args.procedure_id,
          ok: false,
          code: review.code,
          next_action: 'procedure_review',
          error: review.code === 'REVIEW_REQUIRED'
            ? 'review token is missing, expired, or already used'
            : 'procedure arguments or repository do not match the reviewed change',
        };
      }
    }
    const fillArgs =
      deps.procedureFillArgs ??
      (args.args !== undefined
        ? async (step: ProcedureStep, repo: string) =>
            args.args![step.tool] !== undefined ? args.args![step.tool]! : defaultFillArgs(step, repo)
        : undefined);
    // Decoupled from the gateway: procedures own their connections.
    // `executeProcedure` lazily creates + closes ephemeral serena/leanctx
    // clients per run when none are injected, so procedures no longer require
    // the server's process-lifetime adapter singletons. Callers may still
    // inject clients (deps.procedureSerena / procedureLeanctx, used by tests).
    const serenaAdapter = deps.procedureSerena;
    const leanctxAdapter = deps.procedureLeanctx;
    const result = await executeProcedure(procedure, {
      repoPath: args.repo,
      store,
      thinkEachStep: deps.procedureThinkEachStep ?? true,
      approve: async () => true, // this tool IS the explicit approval
      ...(fillArgs !== undefined ? { fillArgs } : {}),
      ...(serenaAdapter !== undefined ? { serena: serenaAdapter } : {}),
      ...(leanctxAdapter !== undefined ? { leanctx: leanctxAdapter } : {}),
    });
    return {
      procedure_id: args.procedure_id,
      ok: result.ok,
      allExecuted: result.allExecuted,
      results: result.results.map((r) => ({
        service: r.service,
        tool: r.tool,
        write: r.write,
        verdict: r.verdict,
        executed: r.executed,
        approved: r.approved,
        output: r.output,
        error: r.error,
        ...(r.verified !== undefined ? { verified: r.verified } : {}),
        ...(r.verifyNote !== undefined ? { verifyNote: r.verifyNote } : {}),
      })),
    };
  } finally {
    if (deps.procedureStore === undefined) {
      try {
        store.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Review guidance for matched procedures that mutate the repo (task 49). The
 * cloud LLM must not auto-execute these — it should present the change for
 * approval via the review gate.
 */
function compileProcedureReviews(
  procedures: Procedure[],
): Array<{ id: string; triggerPattern: string; note: string }> {
  return procedures
    .filter((p) => p.riskTier === 'requires_review' || p.steps.some((s) => isWriteStep(s)))
    .map((p) => ({
      id: p.id,
      triggerPattern: p.triggerPattern,
      note: 'Mutates the repo. Do NOT auto-execute — present the proposed change for user approval before running (review gate).',
    }));
}

/** `steer` — steer a task with the local LLM, pick the strategy. */
export async function steerTool(
  args: SteerArgs,
  deps: McpDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof args.task !== 'string' || args.task.length === 0) {
    throw new Error('steer requires a non-empty string "task"');
  }
  const d = resolveDeps(deps);
  // Quick, inexpensive memory lookup: if the project-scoped memory DB contains
  // matching memories for this task, surface them as an auto-generated plan
  // placed into the `tasks/` directory. This is intentionally shallow (simple
  // substring search) to keep the steering stateless and fast.
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
  const steerStart = performance.now();
  const outcome = await steerOrDegrade(d, args.task);
  const steerLatencyMs = Math.round(performance.now() - steerStart);
  // Capture status after steering so a down->recovering request reports
  // `warming` (its fast default + notice) rather than the stale pre-call `down`.
  const llmStatus = d.llmStatus.status;
  const llmUnavailable = d.llmStatus.isUnavailable();
  // The model only classifies + extracts entities; synthesize the token-saving
  // fields (tool_plan / evidence_plan / response_policy / reminders) in code.
  const steering = synthesizePlans(outcome.steering);
  const strategy = d.getStrategy(outcome.steering);
  recordSteeringCall(d.record, outcome, args.task, requestId, steerLatencyMs);
  // Procedure handoff: match routine, read-only tasks against the local LLM's
  // procedures so the cloud LLM can hand off execution instead of doing it
  // itself. Best-effort — never breaks steering if the store is missing.
  let procedures: Procedure[] | undefined;
  try {
    const store =
      deps.procedureStore ??
      new ProcedureStore();
    try {
      procedures = store.findMatches(steering.entities, args.task);
    } finally {
      if (deps.procedureStore === undefined) {
        try {
          store.close();
        } catch (e) {
          void e;
        }
      }
    }
  } catch (err) {
    d.log(`procedure lookup skipped: ${(err as Error).message}`);
  }
  const usesMemory =
    steering.memory?.use ??
    toolPlanUses(steering.tool_plan, 'chat_memory_store');
  // Option B: when a procedure matches the task, add a `procedure_apply`
  // directive to the tool_plan so the cloud LLM hands off via the steering it
  // already follows (rather than doing the work manually). Best-effort.
  if (procedures !== undefined && procedures.length > 0) {
    const best = procedures[0]!;
    const plan = steering.tool_plan ?? { recommended_tools: [] };
    if (!(plan.recommended_tools ?? []).some((t) => t.name === 'procedure_apply')) {
      plan.recommended_tools = [
        ...(plan.recommended_tools ?? []),
        {
          name: 'procedure_apply',
          intent: `Hand off to the matched procedure "${best.triggerPattern}" (id ${best.id}) — call procedure_review first to preview it, then procedure_apply with approved:true. Use this instead of doing the work manually.`,
          priority: 1,
        },
      ];
    }
    steering.tool_plan = plan;
  }
  const slimProcedures = procedures?.map(slimProcedure);
  const procedureContract = procedures !== undefined && procedures.length > 0 && !outcome.degraded
    ? procedures.slice(0, 1).map((p) => ({
        procedure_id: p.id,
        required_sequence: p.steps.some((step) => isWriteStep(step))
          ? ['procedure_review', 'procedure_apply']
          : ['procedure_apply'],
        approval_required: p.steps.some((step) => isWriteStep(step)),
        risk_tier: p.riskTier,
      }))
    : undefined;
  return {
    // Most important directions first (response_policy -> ... -> request_id).
    response_policy: compileResponsePolicy(steering.response_policy),
    tool_plan: compileToolPlan(steering.tool_plan),
    reminders: compileReminders(steering),
    steering: coreSteering(steering),
    entities: steering.entities,
    strategy: serializeStrategy(strategy),
    memory_hints: compileMemoryHints(steering),
    ...(usesMemory === 'if_necessary'
      ? { memory_policy: memoryPolicyFor(usesMemory) }
      : {}),
    ...(compileSubtasks(steering) !== undefined
      ? { subtasks: compileSubtasks(steering) }
      : {}),
    ...(compileRetrieval(steering.retrieval) !== null
      ? { retrieval: compileRetrieval(steering.retrieval) }
      : {}),
    degraded: outcome.degraded,
    llm_status: llmStatus,
    ...(llmUnavailable ? { notice: outcome.reason } : {}),
    ...(llmUnavailable ? { procedures_unavailable: true } : {}),
    ...(relevant_memories !== undefined ? { relevant_memories } : {}),
    ...(slimProcedures !== undefined ? { procedures: slimProcedures } : {}),
    ...(procedureContract !== undefined ? { procedure_contract: procedureContract } : {}),
    ...(slimProcedures !== undefined
      ? { procedures_review: compileProcedureReviews(procedures!) }
      : {}),
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
    name: 'steering',
    description:
      'Steer the user request with the local LLM and return the recommended ' +
      'optimisation strategy (LeanCTX mode, compression, search approach), a ' +
      'tool_plan (tools to use/skip) and a response_policy (directives to follow ' +
      'when replying). Call this first on the user request before using the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user request / task to steer.',
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
    name: 'procedure_review',
    description:
      'Build a concrete, reviewable diff for the write step(s) of a matched procedure against a real repo, WITHOUT applying anything. ' +
      'Use before approving a write procedure so the user sees exactly what will change.',
    inputSchema: {
      type: 'object',
      properties: {
        procedure_id: { type: 'string', description: 'The procedure id to review.' },
        repo: { type: 'string', description: 'Absolute repo path to review against.' },
        step_index: { type: 'number', description: 'Optional 0-based write-step index; omit to review all write steps.' },
      },
      required: ['procedure_id', 'repo'],
    },
  },
  {
    name: 'procedure_apply',
    description:
      'Approve + apply a reviewed write procedure in-agent. Requires approved:true (this tool is the review gate). ' +
      'Runs the procedure steps against the real repo and records the outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        procedure_id: { type: 'string', description: 'The procedure id to apply.' },
        repo: { type: 'string', description: 'Absolute repo path to apply against.' },
        approved: { type: 'boolean', description: 'Must be true to apply write steps.' },
        args: { type: 'object', description: 'Optional per-tool arg overrides, e.g. { "create_text_file": {...} }.' },
      },
      required: ['procedure_id', 'repo', 'approved'],
    },
  },
  {
    name: 'optimize_context',
    description:
      'Steer a task, then return the LeanCTX-compressed representation of a file/directory as context. ' +
      'Use this instead of reading a large file raw, or to expand/triage shell/command output before ' +
      'sending it to the model.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The task description used to steer and pick the LeanCTX mode.',
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
          description: 'The shared request id returned by steer / previous tool calls.',
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
  const instrument = deps.instrument ?? getInstrumenter();
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const requestId = randomUUID();
  const start = performance.now();
  instrument.requestStarted({
    id: requestId,
    tool: 'mcp',
    operation: name,
    inputHint: hintText(args),
  });
  try {
    let result: Record<string, unknown>;
    switch (name) {
      case 'steering':
        result = await steerTool(args as unknown as SteerArgs, deps);
        break;
      // Temporary migration alias: `classify` -> `steering` (Task 59).
      case 'classify':
        result = await steerTool(args as unknown as SteerArgs, deps);
        break;
      case 'procedure_review':
        result = await procedureReviewTool(
          args as unknown as ProcedureReviewArgs,
          deps,
        );
        break;
      case 'procedure_apply':
        result = await procedureApplyTool(args as unknown as ProcedureApplyArgs, deps);
        break;
      case 'optimize_context':
        result = await optimizeContextTool(
          args as unknown as OptimizeContextArgs,
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
    instrument.responded({
      id: requestId,
      ok: true,
      latencyMs: Math.round(performance.now() - start),
      outputHint: hintText(result),
    });
    // Metric-affecting ops -> tell the UI to re-fetch stats.
    instrument.statsUpdated();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    instrument.responded({
      id: requestId,
      ok: false,
      latencyMs: Math.round(performance.now() - start),
    });
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

/** Build the stdio MCP server exposing the engine as tools (design doc §16). */
export function createMcpServer(deps: McpDeps = {}): Server {
  const server = new Server(
    { name: 'cadet-brainstem', version: pkg.version },
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
  // Fire-and-forget: warm the local LLM in the background so the first
  // steer doesn't pay the cold-load latency. Never blocks the server —
  // until ready, steer returns fast conservative defaults with a notice.
  void warmUpOnServerStart(resolved);
  // Auto-start the in-process dashboard (design §9.2) so live steer/MCP
  // events stream to it over the shared EventBus. Best-effort, non-blocking.
  void startInProcessDashboard().catch(() => undefined);
  // Client disconnected — release the persistent Serena session (if any).
  await resolved.serena.close?.().catch(() => undefined);
  return 0;
}

/**
 * Kick off the local-LLM warm-up and drive the availability state machine.
 * Runs detached (fire-and-forget) from the MCP server lifecycle.
 */
async function warmUpOnServerStart(d: ResolvedDeps): Promise<void> {
  d.llmStatus.set('warming');
  const result = await warmUpOllama({ log: d.log });
  if (result.ok) {
    d.llmStatus.set('ready');
    d.log(`[cadet-brainstem] local LLM ready (warm-up ${result.latencyMs}ms)`);
  } else {
    d.llmStatus.set('down');
    d.log(`[cadet-brainstem] local LLM down after warm-up: ${result.error ?? 'unknown error'}`);
  }
}
