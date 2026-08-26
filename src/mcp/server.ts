import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pkg from '../../package.json';
import { classifyWithFallback, type ClassificationOutcome } from '../classifier';
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
} from '../metrics';

/** Stable session id stamped on events recorded by MCP tool calls. */
export const MCP_SESSION_ID = 'mcp';

/**
 * Response policy the agent must parse and follow when replying after using
 * this tool. Returned by `classify` (and `optimize_context`) so the agent can
 * read it and stick to it. Targets token-efficient, LLM-consumable responses.
 */
export const RESPONSE_POLICY =
  'Write for another LLM, not for presentation. Preserve decisions, constraints, actions, errors ' +
  'and evidence. Remove decoration, repetition and conversational filler. Keep output compact and ' +
  'information-dense. Avoid decorative formatting, unnecessary emojis, repeated information, and ' +
  'explanations that do not affect the task. Assume your response may become future LLM context.';

export interface McpDeps {
  classify?: (taskText: string) => Promise<ClassificationOutcome>;
  getStrategy?: (classification: Classification) => OptimisationStrategy;
  leanctx?: Pick<LeanCtxAdapter, 'optimize'>;
  rtk?: Pick<RtkAdapter, 'optimize'>;
  serena?: Pick<SerenaAdapter, 'search'>;
  metricsPath?: string;
  record?: (event: OptimisationEvent) => void;
  log?: (line: string) => void;
}

interface ResolvedDeps {
  classify: (taskText: string) => Promise<ClassificationOutcome>;
  getStrategy: (classification: Classification) => OptimisationStrategy;
  leanctx: Pick<LeanCtxAdapter, 'optimize'>;
  rtk: Pick<RtkAdapter, 'optimize'>;
  serena: Pick<SerenaAdapter, 'search'>;
  metricsPath: string;
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

function resolveDeps(deps: McpDeps = {}): ResolvedDeps {
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();
  return {
    classify: deps.classify ?? classifyWithFallback,
    getStrategy:
      deps.getStrategy ??
      ((classification) => new PolicyEngine().getStrategy(classification)),
    leanctx: deps.leanctx ?? new LeanCtxAdapter(),
    rtk: deps.rtk ?? new RtkAdapter(),
    serena: deps.serena ?? new SerenaAdapter(),
    metricsPath,
    record: deps.record ?? defaultRecorder(metricsPath),
    log: deps.log ?? ((line: string) => console.error(line)),
  };
}

// ── Tool handlers (pure, unit-testable) ───────────────────────────────────

export interface OptimizeContextArgs {
  task: string;
  target: string;
  lines?: string;
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
  record({
    timestamp: new Date().toISOString(),
    session_id: MCP_SESSION_ID,
    task_type: outcome.classification.task,
    complexity: outcome.classification.complexity,
    risk: outcome.classification.risk,
    tool: 'ollama',
    operation: 'classify',
    estimated_input_tokens: Math.round(Buffer.byteLength(taskText) / 4) + 50,
    estimated_output_tokens: 25,
    estimated_tokens_saved: 0,
    compression_ratio: null,
    optimisation_strategy: null,
    degraded: outcome.degraded,
    latency_ms: latencyMs,
    request_id: requestId,
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
  const requestId = randomUUID();
  const classifyStart = performance.now();
  const outcome = await d.classify(args.task);
  const classifyLatencyMs = Math.round(performance.now() - classifyStart);
  const strategy = d.getStrategy(outcome.classification);
  recordClassifierCall(d.record, outcome, args.task, requestId, classifyLatencyMs);
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
  return {
    context: result.context,
    mode: result.mode,
    sourceSize: result.sourceSize,
    returnedSize: result.returnedSize,
    estimatedTokensSaved: result.estimatedTokensSaved,
    degraded: result.degraded,
    classification: outcome.classification,
    strategy,
    response_policy: RESPONSE_POLICY,
  };
}

export interface ClassifyArgs {
  task: string;
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
  const requestId = randomUUID();
  const classifyStart = performance.now();
  const outcome = await d.classify(args.task);
  const classifyLatencyMs = Math.round(performance.now() - classifyStart);
  const strategy = d.getStrategy(outcome.classification);
  recordClassifierCall(d.record, outcome, args.task, requestId, classifyLatencyMs);
  return {
    classification: outcome.classification,
    strategy,
    response_policy: RESPONSE_POLICY,
    degraded: outcome.degraded,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

export interface FindSymbolsArgs {
  query: string;
  cwd: string;
  project?: string;
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
  const requestId = randomUUID();
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
  };
}

export interface CompressOutputArgs {
  command: string;
  cwd?: string;
  shell?: string;
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
  const requestId = randomUUID();
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
    ...(note !== undefined ? { note } : {}),
  };
}

// ── Tool registry + MCP server wiring ─────────────────────────────────────

const TOOL_DEFS = [
  {
    name: 'classify',
    description:
      'Classify the user request with the local LLM and return the recommended ' +
      'optimisation strategy (LeanCTX mode, compression, search approach). Call ' +
      'this first on the user request before using the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The user request / task to classify.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'optimize_context',
    description:
      'Classify a task, then return the LeanCTX-compressed representation of a file/directory as context. ' +
      'Use this instead of reading a large file raw.',
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
      },
      required: ['query', 'cwd'],
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
      },
      required: ['command'],
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
      case 'compress_command_output':
        result = await compressCommandOutputTool(
          args as unknown as CompressOutputArgs,
          deps,
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
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return 0;
}
