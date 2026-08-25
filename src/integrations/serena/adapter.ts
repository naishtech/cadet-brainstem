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

  /** Invoke Serena's `find_symbol` tool over MCP. */
  async search(request: SerenaSearchRequest): Promise<SerenaSearchResult> {
    const transport = new StdioClientTransport({
      command: SERENA_BIN,
      args: ['start-mcp-server'],
      cwd: request.cwd,
    });
    const client = new Client({ name: 'cadet-token-saver', version: '0.1.0' });

    try {
      await client.connect(transport);
      // Serena requires an active project before symbol search works.
      await client.callTool({
        name: 'activate_project',
        arguments: { project: request.project ?? request.cwd },
      });
      const result = await client.callTool({
        name: 'find_symbol',
        arguments: { name_path_pattern: request.query },
      });
      const rawText = extractText(result);
      if (ERROR_RE.test(rawText.trim())) {
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
    } catch {
      // Graceful skip — no crash, no data loss.
      return {
        query: request.query,
        symbols: [],
        files: [],
        rawText: '',
        degraded: true,
      };
    } finally {
      await client.close().catch(() => undefined);
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
