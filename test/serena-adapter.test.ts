import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SerenaAdapter, parseSymbols } from '../src/integrations/serena/index';
import type { OptimisationStrategy } from '../src/policy/index';

const { execFileMock, mcpMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  mcpMock: {
    callToolResult: { content: [{ type: 'text', text: '' }] },
    calls: [] as Array<{ name: string; arguments?: Record<string, unknown> }>,
    transportOpts: [] as unknown[],
    failConnect: false,
    failCall: false,
  },
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

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
    async close(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(public opts: { command: string; args: string[]; cwd: string }) {
      mcpMock.transportOpts.push(opts);
    }
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
  mcpMock.failConnect = false;
  mcpMock.failCall = false;
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
});
