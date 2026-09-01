import { readFileSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ContextOptimizer } from '../../core';
import type { LeanCtxMode } from '../../policy/schema';

const execFile = promisify(execFileCb);

export const LEAN_CTX_BIN = 'lean-ctx';
/** Arguments that launch LeanCTX's stdio MCP server (`lean-ctx mcp`). */
export const LEAN_CTX_MCP_ARGS = ['mcp'];

/**
 * Map the design-doc LeanCTX modes (the policy's `leanctx_mode`) to the CLI's
 * `lean-ctx read <file> -m <mode>` read modes. Modes LeanCTX does not expose
 * directly are mapped to the nearest supported equivalent.
 */
export const LEAN_CTX_MODE_MAP: Record<LeanCtxMode, string> = {
  full: 'full',
  raw: 'full', // raw = full uncompressed content
  lines: 'lines', // requires a range; resolved in resolveCliMode
  diff: 'diff',
  reference: 'reference',
  signatures: 'signatures',
  map: 'map',
  cognitive: 'entropy', // nearest supported read mode
  task: 'task',
  density: 'aggressive', // nearest supported read mode
  aggressive: 'aggressive',
};

export interface LeanCtxOptimizeRequest {
  /** File/path whose context should be compiled. */
  target: string;
  /** Mode from the policy engine (Task 07). */
  mode: LeanCtxMode;
  /** Steering from the steering, recorded in metrics. */
  taskType: string;
  /** Optional token budget (reserved; used by the compile path in future). */
  budget?: number;
  /** Line range for the `lines` mode, e.g. "10-50". */
  lines?: string;
}

export interface LeanCtxResult {
  context: string;
  sourceSize: number;
  returnedSize: number;
  mode: string;
  estimatedTokensSaved: number;
  taskType: string;
  degraded: boolean;
}

/** Generic passthrough request — forward any call to any `ctx_*` tool. */
export interface LeanCtxCallRequest {
  /** LeanCTX tool name, e.g. ctx_read, ctx_shell, ctx_search, ctx_explore. */
  tool: string;
  /** Arguments forwarded verbatim to the LeanCTX tool. */
  arguments?: Record<string, unknown>;
  /** Project directory LeanCTX should operate in (defaults to process.cwd()). */
  cwd?: string;
}

export interface LeanCtxToolResult {
  tool: string;
  /** Raw MCP callTool result — always preserved. */
  result: unknown;
  /** Extracted text content of the result. */
  rawText: string;
  degraded: boolean;
}

/** A live, reusable connection to a single `lean-ctx mcp` server process. */
interface LeanCtxSession {
  client: Client;
  transport: StdioClientTransport;
  /** cwd the process was spawned in. */
  cwd: string;
}

/** LeanCTX reports tool failures as text blocks — detect them as degraded. */
const ERROR_RE = /^Error(?: executing tool[^:]*)?:/i;

/** Extract the concatenated text content from an MCP callTool result. */
function extractText(result: unknown): string {
  const content = (result as { content?: unknown[] } | null)?.content;
  const blocks = (content ?? []) as Array<{ type?: string; text?: unknown }>;
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** Resolve the CLI read-mode string for a request. */
export function resolveCliMode(request: LeanCtxOptimizeRequest): string {
  if (request.mode === 'lines' && request.lines !== undefined) {
    return `lines:${request.lines}`;
  }
  return LEAN_CTX_MODE_MAP[request.mode];
}

async function runLeanCtx(args: string[]): Promise<string> {
  const { stdout } = await execFile(LEAN_CTX_BIN, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/**
 * LeanCTX adapter (design doc §7). Treats LeanCTX as the context compiler:
 * Cadet Brainstem decides what context a task needs (mode from the policy);
 * LeanCTX decides the representation. This adapter only passes mode/budget
 * through — it never reproduces LeanCTX's algorithms.
 */
export class LeanCtxAdapter implements ContextOptimizer {
  readonly name = 'leanctx';

  /** Persistent MCP session — spawned once, reused for the server lifetime. */
  private session: LeanCtxSession | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile(LEAN_CTX_BIN, ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Return a context representation for `target` via LeanCTX. */
  async optimize(request: LeanCtxOptimizeRequest): Promise<LeanCtxResult> {
    const source = readFileSync(request.target, 'utf8');
    const sourceSize = Buffer.byteLength(source);

    let output: string;
    let mode: string;
    try {
      mode = resolveCliMode(request);
      output = await runLeanCtx(['read', request.target, '-m', mode]);
    } catch {
      // Graceful fallback: return the unoptimised context, no data loss.
      return {
        context: source,
        sourceSize,
        returnedSize: sourceSize,
        mode: 'raw',
        estimatedTokensSaved: 0,
        taskType: request.taskType,
        degraded: true,
      };
    }

    const returnedSize = Buffer.byteLength(output);
    return {
      context: output,
      sourceSize,
      returnedSize,
      mode,
      estimatedTokensSaved: Math.max(0, Math.round((sourceSize - returnedSize) / 4)),
      taskType: request.taskType,
      degraded: false,
    };
  }

  /**
   * Lazily spawn `lean-ctx mcp` once and reuse the connection for the server
   * lifetime, so tools don't pay a per-call process start. LeanCTX is
   * cwd-based (no project-activation ceremony like Serena); the session is
   * keyed by cwd.
   */
  private async getSession(cwd: string): Promise<LeanCtxSession> {
    const existing = this.session;
    if (existing !== null && existing.cwd === cwd) {
      return existing;
    }
    if (existing !== null) {
      await this.close().catch(() => undefined);
    }
    return this.connect(cwd);
  }

  private async connect(cwd: string): Promise<LeanCtxSession> {
    const transport = new StdioClientTransport({
      command: LEAN_CTX_BIN,
      args: LEAN_CTX_MCP_ARGS,
      cwd,
      // Tag LeanCTX's persisted analytics (gain/cost/ledger/heatmap) as ours so
      // `ctx_gain agents` / `ctx_cost agent` attribute the usage to us.
      env: { ...process.env, LEAN_CTX_AGENT_ID: 'cadet-brainstem' },
    });
    const client = new Client({ name: 'cadet-brainstem', version: '0.1.0' });
    await client.connect(transport);
    this.session = { client, transport, cwd };
    return this.session;
  }

  /** Run a call against the persistent session; reconnect once on failure. */
  private async retryOnConnection<T>(
    cwd: string,
    fn: (session: LeanCtxSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.getSession(cwd);
    try {
      return await fn(session);
    } catch {
      // Connection-level failure: tear down and reconnect once, then retry.
      await this.close().catch(() => undefined);
      session = await this.connect(cwd);
      return await fn(session);
    }
  }

  /**
   * Generic passthrough — forward any call to any `ctx_*` tool over MCP, so
   * new LeanCTX tools work without updating this adapter (mirrors Serena).
   */
  async callTool(request: LeanCtxCallRequest): Promise<LeanCtxToolResult> {
    const cwd = request.cwd ?? process.cwd();
    const tool = request.tool;
    try {
      return await this.retryOnConnection(cwd, async (session) => {
        const result = await session.client.callTool({
          name: tool,
          arguments: request.arguments ?? {},
        });
        const rawText = extractText(result);
        return {
          tool,
          result,
          rawText,
          degraded: ERROR_RE.test(rawText.trim()) || result.isError === true,
        };
      });
    } catch {
      return { tool, result: null, rawText: '', degraded: true };
    }
  }

  /** Close the persistent session (call on server shutdown). */
  async close(): Promise<void> {
    if (this.session !== null) {
      const { client, transport } = this.session;
      this.session = null;
      await client.close().catch(() => undefined);
      transport.close();
    }
  }

  async install(): Promise<void> {
    // Never auto-install — surface the documented command instead.
    console.log(
      '[cadet-brainstem] leanctx not installed. See https://github.com/naishtech/cadet-brainstem/blob/main/docs/requirements.md — on Windows download ' +
        'lean-ctx-x86_64-pc-windows-msvc.zip and add lean-ctx.exe to your PATH.',
    );
  }

  async configure(): Promise<void> {
    await runLeanCtx(['doctor']).catch(() => undefined);
  }
}
