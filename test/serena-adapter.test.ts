import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SerenaAdapter, parseSymbols } from '../src/integrations/serena/index';
import type { OptimisationStrategy } from '../src/policy/index';

const { execFileMock, mcpMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  mcpMock: {
    callToolResult: { content: [{ type: 'text', text: '' }] },
    listToolsResult: { tools: [] as Array<{ name: string }> },
    calls: [] as Array<{ name: string; arguments?: Record<string, unknown> }>,
    transportOpts: [] as unknown[],
    failConnect: false,
    failCall: false,
    closed: 0,
  },
}));

vi.mock('node:child_process', () => ({ exec: execFileMock, execFile: execFileMock }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor(public info: { name: string; version: string }) {}
    async connect(): Promise<void> {
      if (mcpMock.failConnect) throw new Error('connect failed');
    }
    async callTool(args: { name: string; arguments?: Record<string, unknown> }) {
      if (mcpMock.failCall) throw new Error('call failed');
      mcpMock.calls.push(args);
      return mcpMock.callToolResult;
    }
    async listTools() {
      return mcpMock.listToolsResult;
    }
    async close(): Promise<void> {
      mcpMock.closed += 1;
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(public opts: { command: string; args: string[]; cwd: string }) {
      mcpMock.transportOpts.push(opts);
    }
    close(): void {}
  },
}));

const semanticStrategy: OptimisationStrategy = {
  context_need: 'targeted',
  compression: 'normal',
  code_search: 'semantic',
  terminal_output: 'normal',
  leanctx_mode: 'task',
};

const nonSemanticStrategy: OptimisationStrategy = {
  context_need: 'minimal',
  compression: 'aggressive',
  code_search: 'none',
  terminal_output: 'normal',
  leanctx_mode: 'reference',
};

beforeEach(() => {
  mcpMock.calls = [];
  mcpMock.transportOpts = [];
  mcpMock.callToolResult = { content: [{ type: 'text', text: '' }] };
  mcpMock.listToolsResult = { tools: [] };
  mcpMock.failConnect = false;
  mcpMock.failCall = false;
  mcpMock.closed = 0;
});

afterEach(() => {
  execFileMock.mockReset();
});

describe('parseSymbols', () => {
  it('extracts file:line references from tool output', () => {
    const text = 'Symbol: Foo\n  Path: src/foo.ts:42:5\nAlso src/bar.js:7\n';
    const symbols = parseSymbols(text);
    expect(symbols.map((s) => s.file)).toContain('src/foo.ts');
    expect(symbols.find((s) => s.file === 'src/foo.ts')?.line).toBe(42);
    expect(symbols.map((s) => s.file)).toContain('src/bar.js');
  });
});

describe('SerenaAdapter', () => {
  let adapter: SerenaAdapter;

  beforeEach(() => {
    adapter = new SerenaAdapter();
  });

  it('is available when serena responds', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.pop() as (err: Error | null) => void;
      cb(null);
    });
    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it('is unavailable when serena is missing', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args.pop() as (err: Error) => void;
      cb(new Error('ENOENT'));
    });
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('uses semantic search only when the policy requests it', () => {
    expect(adapter.shouldUseSemanticSearch(semanticStrategy)).toBe(true);
    expect(adapter.shouldUseSemanticSearch(nonSemanticStrategy)).toBe(false);
  });

  it('calls find_symbol via MCP and shapes results for LeanCTX', async () => {
    mcpMock.callToolResult = {
      content: [
        { type: 'text', text: 'Symbol: Config\n  Path: src/config/config.ts:20\n' },
      ],
    };
    const result = await adapter.search({ query: 'Config', cwd: 'E:/proj' });

    expect(result.degraded).toBe(false);
    expect(result.files).toEqual(['src/config/config.ts']);
    expect(result.symbols[0]?.line).toBe(20);
    expect(result.rawText).toContain('src/config/config.ts');

    expect(mcpMock.calls[0]?.name).toBe('activate_project');
    expect(mcpMock.calls[0]?.arguments).toEqual({ project: 'E:/proj' });
    expect(mcpMock.calls[1]?.name).toBe('find_symbol');
    expect(mcpMock.calls[1]?.arguments).toEqual({ name_path_pattern: 'Config' });
    expect(mcpMock.transportOpts[0]).toMatchObject({
      command: 'serena',
      args: ['start-mcp-server'],
      cwd: 'E:/proj',
    });
  });

  it('uses the explicit project override when provided', async () => {
    mcpMock.callToolResult = {
      content: [{ type: 'text', text: 'Symbol: Config\n  Path: src/config.ts:1\n' }],
    };
    await adapter.search({ query: 'Config', cwd: 'E:/proj', project: 'cadet' });
    expect(mcpMock.calls[0]?.arguments).toEqual({ project: 'cadet' });
  });

  it('marks a Serena tool error text block as degraded', async () => {
    mcpMock.callToolResult = {
      content: [
        {
          type: 'text',
          text: 'Error executing tool find_symbol: No active project.',
        },
      ],
    };
    const result = await adapter.search({ query: 'Config', cwd: 'E:/proj' });
    expect(result.degraded).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.rawText).toContain('No active project');
  });

  it('degrades gracefully when the MCP call fails', async () => {
    mcpMock.failCall = true;
    const result = await adapter.search({ query: 'Config', cwd: 'E:/proj' });
    expect(result.degraded).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.rawText).toBe('');
  });

  it('reuses a single persistent session across calls', async () => {
    mcpMock.callToolResult = {
      content: [{ type: 'text', text: 'Symbol: Config\n  Path: src/config.ts:1\n' }],
    };
    await adapter.search({ query: 'Config', cwd: 'E:/proj' });
    await adapter.search({ query: 'Other', cwd: 'E:/proj' });
    // One process spawned, project activated once.
    expect(mcpMock.transportOpts).toHaveLength(1);
    expect(mcpMock.calls.filter((c) => c.name === 'activate_project')).toHaveLength(1);
    expect(mcpMock.calls.filter((c) => c.name === 'find_symbol')).toHaveLength(2);
  });

  it('switches the active project on a live session', async () => {
    mcpMock.callToolResult = {
      content: [{ type: 'text', text: 'Symbol: X\n  Path: x.ts:1\n' }],
    };
    await adapter.search({ query: 'X', cwd: 'E:/proj' });
    await adapter.search({ query: 'Y', cwd: 'E:/other' });
    expect(mcpMock.transportOpts).toHaveLength(1);
    const activations = mcpMock.calls.filter((c) => c.name === 'activate_project');
    expect(activations).toHaveLength(2);
    expect(activations[1]?.arguments).toEqual({ project: 'E:/other' });
  });

  it('forwards any Serena tool via callTool', async () => {
    mcpMock.callToolResult = {
      content: [{ type: 'text', text: 'references:\n  Foo: src/a.h:3' }],
    };
    const result = await adapter.callTool({
      tool: 'find_referencing_symbols',
      arguments: { name_path_pattern: 'Foo' },
      cwd: 'E:/proj',
    });
    expect(result.tool).toBe('find_referencing_symbols');
    expect(result.degraded).toBe(false);
    expect(result.rawText).toContain('references');
    const forwarded = mcpMock.calls.find((c) => c.name === 'find_referencing_symbols');
    expect(forwarded?.arguments).toEqual({ name_path_pattern: 'Foo' });
  });

  it('lists the tools Serena currently exposes', async () => {
    mcpMock.listToolsResult = {
      tools: [{ name: 'find_symbol' }, { name: 'rename_symbol' }],
    };
    const result = await adapter.listTools({ cwd: 'E:/proj' });
    expect(result.degraded).toBe(false);
    expect(result.tools.map((t) => t.name)).toEqual(['find_symbol', 'rename_symbol']);
  });

  it('close() releases the persistent session', async () => {
    await adapter.search({ query: 'Config', cwd: 'E:/proj' });
    await adapter.close();
    expect(mcpMock.closed).toBe(1);
    // A later call reconnects (new spawn).
    await adapter.search({ query: 'Config', cwd: 'E:/proj' });
    expect(mcpMock.transportOpts).toHaveLength(2);
  });
});

describe('MCP dispatch reuses ONE shared Serena instance (no respawn per call)', () => {
  let dir: string;
  let metricsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cts-serena-singleton-'));
    metricsPath = join(dir, 'metrics.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('spawns a single serena process across multiple find_relevant_symbols calls', async () => {
    // Reset the module registry so `src/mcp/server.ts`'s shared adapter
    // singleton starts fresh (otherwise a prior test may have already connected).
    vi.resetModules();
    mcpMock.transportOpts = [];
    const { handleToolCall } = await import('../src/mcp');

    // Two separate MCP tool calls, NO injected serena adapter.
    await handleToolCall(
      'find_relevant_symbols',
      { query: 'Config', cwd: 'E:/proj' },
      { metricsPath },
    );
    await handleToolCall(
      'find_relevant_symbols',
      { query: 'Other', cwd: 'E:/proj' },
      { metricsPath },
    );

    // The shared adapter connected once and reused the session for the 2nd call,
    // so only ONE serena MCP server process was ever spawned (was 2 before the
    // singleton fix: a new adapter spawned a fresh process per call).
    expect(mcpMock.transportOpts).toHaveLength(1);
    expect(mcpMock.calls.filter((c) => c.name === 'find_symbol')).toHaveLength(2);
  }, 20000);
});
