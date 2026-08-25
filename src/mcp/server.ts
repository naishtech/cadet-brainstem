import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
  const outcome = await d.classify(args.task);
  const strategy = d.getStrategy(outcome.classification);
  const result = await d.leanctx.optimize({
    target: args.target,
    mode: strategy.leanctx_mode,
    taskType: outcome.classification.task,
    ...(args.lines !== undefined ? { lines: String(args.lines) } : {}),
  });
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
  const result = await d.serena.search({
    query: args.query,
    cwd: args.cwd,
    ...(args.project !== undefined ? { project: String(args.project) } : {}),
  });
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
}

/**
 * `compress_command_output` — run a read-only command and return its
 * RTK-reduced output. The full raw output is never sent back (that is the
 * point); its size is reported so savings are measurable.
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
  const result = await d.rtk.optimize({
    command: args.command,
    ...(args.cwd !== undefined ? { cwd: String(args.cwd) } : {}),
  });
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
  });
  return {
    command: result.command,
    optimisedOutput: result.optimisedOutput,
    rawOutputSize: result.rawOutputSize,
    optimisedOutputSize: result.optimisedOutputSize,
    estimatedTokensBefore: result.estimatedTokensBefore,
    estimatedTokensAfter: result.estimatedTokensAfter,
    estimatedTokensSaved: result.estimatedTokensSaved,
    degraded: result.degraded,
  };
}

// ── Tool registry + MCP server wiring ─────────────────────────────────────

const TOOL_DEFS = [
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
      'Run a read-only command and return its RTK-compressed output. Use for noisy commands ' +
      '(git status, ls, tests) before sending their output as context.',
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
