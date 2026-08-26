import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ContextOptimizer } from '../../core';
import type { OptimisationStrategy } from '../../policy/schema';

const execFile = promisify(execFileCb);

export const SERENA_BIN = 'serena';

export interface SerenaSearchRequest {
  /** Symbol name / path pattern to find. */
  query: string;
  /** Project directory Serena should operate in. */
  cwd: string;
  /** Optional explicit Serena project name/path (defaults to `cwd`). */
  project?: string;
}

export interface SerenaSymbol {
  name: string;
  file: string;
  line?: number;
}

export interface SerenaSearchResult {
  query: string;
  symbols: SerenaSymbol[];
  /** Unique relevant files — shaped for downstream LeanCTX consumption. */
  files: string[];
  /** Raw tool output — always preserved. */
  rawText: string;
  degraded: boolean;
}

export interface SerenaCallRequest {
  /** Serena tool name, e.g. find_symbol, find_referencing_symbols, rename_symbol. */
  tool: string;
  /** Arguments forwarded verbatim to the Serena tool. */
  arguments?: Record<string, unknown>;
  /** Project directory Serena should operate in (defaults to process.cwd()). */
  cwd?: string;
  /** Optional explicit Serena project name/path (defaults to cwd). */
  project?: string;
}

export interface SerenaToolResult {
  tool: string;
  /** Raw MCP callTool result — always preserved. */
  result: unknown;
  /** Extracted text content of the result. */
  rawText: string;
  degraded: boolean;
}

export interface SerenaListRequest {
  cwd?: string;
  project?: string;
}

export interface SerenaListResult {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  degraded: boolean;
}

/** A live, reusable connection to a single serena MCP server process. */
interface SerenaSession {
  client: Client;
  transport: StdioClientTransport;
  /** Currently active project path. */
  project: string;
  /** cwd the process was spawned in. */
  cwd: string;
}

const FILE_RE =
  /([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|cs|java|cpp|c|h|hpp|md|json|yaml|yml|vue|svelte))(?::(\d+))?/gi;

/** Serena reports tool failures as text blocks — detect them as degraded. */
const ERROR_RE = /^Error(?: executing tool[^:]*)?:/i;

/** Best-effort parse of symbol output into name/file/line entries. */
export function parseSymbols(text: string): SerenaSymbol[] {
  const symbols: SerenaSymbol[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_RE)) {
    const file = match[1] ?? '';
    const line = match[2] !== undefined ? Number(match[2]) : undefined;
    const name = file.split(/[/\\]/).pop() ?? file;
    const key = `${file}:${line ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (line !== undefined) {
        symbols.push({ name, file, line });
      } else {
        symbols.push({ name, file });
      }
    }
  }
  return symbols;
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown[] } | null)?.content;
  const blocks = (content ?? []) as Array<{ type?: string; text?: unknown }>;
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/**
 * Serena adapter (design doc §6). Exposes semantic code navigation when the
 * policy requires it. Serena is an MCP server, so the adapter makes an MCP
 * tool call (`find_symbol`) via the official MCP SDK — it does NOT reimplement
 * Serena's search. Results are shaped for downstream LeanCTX consumption.
 */
export class SerenaAdapter implements ContextOptimizer {
  readonly name = 'serena';

  /** Persistent session — spawned once, reused for the server lifetime. */
  private session: SerenaSession | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile(SERENA_BIN, ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Decide whether the strategy calls for semantic navigation. */
  shouldUseSemanticSearch(strategy: OptimisationStrategy): boolean {
    return strategy.code_search === 'semantic';
  }

  /**
   * Lazily spawn serena once and reuse the connection for the server lifetime,
   * so tools don't pay a per-call process start (and no re-activate ceremony).
   */
  private async getSession(cwd: string, project?: string): Promise<SerenaSession> {
    const target = project ?? cwd;
    const existing = this.session;
    if (existing !== null) {
      if (existing.cwd === cwd && existing.project === target) {
        return existing;
      }
      // Different project on a live session — switch the active project.
      try {
        await existing.client.callTool({
          name: 'activate_project',
          arguments: { project: target },
        });
        existing.cwd = cwd;
        existing.project = target;
        return existing;
      } catch {
        await this.close().catch(() => undefined);
      }
    }
    return this.connect(cwd, target);
  }

  private async connect(cwd: string, project: string): Promise<SerenaSession> {
    const transport = new StdioClientTransport({
      command: SERENA_BIN,
      args: ['start-mcp-server'],
      cwd,
    });
    const client = new Client({ name: 'cadet-token-saver', version: '0.1.0' });
    await client.connect(transport);
    await client.callTool({
      name: 'activate_project',
      arguments: { project },
    });
    this.session = { client, transport, project, cwd };
    return this.session;
  }

  /** Run a call against the persistent session; reconnect once on failure. */
  private async retryOnConnection<T>(
    cwd: string,
    project: string | undefined,
    fn: (session: SerenaSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.getSession(cwd, project);
    try {
      return await fn(session);
    } catch {
      // Connection-level failure: tear down and reconnect once, then retry.
      await this.close().catch(() => undefined);
      session = await this.connect(cwd, project ?? cwd);
      return await fn(session);
    }
  }

  /** Invoke Serena's `find_symbol` tool over MCP (persistent connection). */
  async search(request: SerenaSearchRequest): Promise<SerenaSearchResult> {
    try {
      return await this.retryOnConnection(
        request.cwd,
        request.project,
        async (session) => {
          const result = await session.client.callTool({
            name: 'find_symbol',
            arguments: { name_path_pattern: request.query },
          });
          const rawText = extractText(result);
          if (ERROR_RE.test(rawText.trim()) || result.isError === true) {
            return {
              query: request.query,
              symbols: [],
              files: [],
              rawText,
              degraded: true,
            };
          }
          const symbols = parseSymbols(rawText);
          return {
            query: request.query,
            symbols,
            files: [...new Set(symbols.map((symbol) => symbol.file))],
            rawText,
            degraded: false,
          };
        },
      );
    } catch {
      // Graceful skip — no crash, no data loss.
      return {
        query: request.query,
        symbols: [],
        files: [],
        rawText: '',
        degraded: true,
      };
    }
  }

  /**
   * Generic passthrough — forward any call to any Serena tool, so new Serena
   * tools work without updating this adapter.
   */
  async callTool(request: SerenaCallRequest): Promise<SerenaToolResult> {
    const cwd = request.cwd ?? process.cwd();
    const tool = request.tool;
    try {
      return await this.retryOnConnection(cwd, request.project, async (session) => {
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

  /** List the tools Serena currently exposes (dynamic discovery). */
  async listTools(request: SerenaListRequest = {}): Promise<SerenaListResult> {
    const cwd = request.cwd ?? process.cwd();
    try {
      return await this.retryOnConnection(cwd, request.project, async (session) => {
        const result = await session.client.listTools();
        const tools = (result.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }));
        return { tools, degraded: false };
      });
    } catch {
      return { tools: [], degraded: true };
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
      '[cadet-token-saver] serena not installed. Install per its own docs, then verify: serena --version.',
    );
  }

  async configure(): Promise<void> {
    // Serena needs no Cadet Token Saver configuration.
  }
}
