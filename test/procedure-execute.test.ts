/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeProcedure, isWriteStep, ProcedureStore, type Procedure } from '../src/procedure';

const { serenaCalls, leanctxCalls } = vi.hoisted(() => ({
  serenaCalls: [] as unknown[],
  leanctxCalls: [] as unknown[],
}));

vi.mock('../src/integrations/serena', () => ({
  SerenaAdapter: class {
    async callTool(request: unknown): Promise<{ rawText: string }> {
      serenaCalls.push(request);
      return { rawText: 'serena ok' };
    }

    async close(): Promise<void> {}
  },
}));

vi.mock('../src/integrations/leanctx', () => ({
  LeanCtxAdapter: class {
    async callTool(request: unknown): Promise<{ rawText: string }> {
      leanctxCalls.push(request);
      return { rawText: 'leanctx ok' };
    }

    async close(): Promise<void> {}
  },
}));

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'to-exec-'));
  dbPath = join(dir, 'procedures.db');
  serenaCalls.length = 0;
  leanctxCalls.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: 'p1',
    triggerPattern: 'test procedure',
    keywords: ['test'],
    steps: [
      { service: 'serena', tool: 'find_symbol', args: { name_path_pattern: 'foo' } },
      { service: 'serena', tool: 'replace_content', args: { relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' } },
    ],
    riskTier: 'requires_review',
    successCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    lastOutcome: null,
    source: 'manually_seeded',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

/** Seed a procedure into the store and return it with its real row id. */
function seed(store: ProcedureStore, overrides: Partial<Procedure> = {}): Procedure {
  const base = makeProcedure(overrides);
  const id = store.seedProcedure({
    triggerPattern: base.triggerPattern,
    keywords: base.keywords,
    steps: base.steps,
    riskTier: base.riskTier,
  });
  return { ...base, id };
}

describe('isWriteStep', () => {
  it('flags mutating tools as write steps', () => {
    expect(isWriteStep({ service: 'serena', tool: 'replace_content' })).toBe(true);
    expect(isWriteStep({ service: 'serena', tool: 'create_text_file' })).toBe(true);
    expect(isWriteStep({ service: 'leanctx', tool: 'ctx_patch' })).toBe(true);
  });

  it('treats read-only tools as non-write', () => {
    expect(isWriteStep({ service: 'serena', tool: 'find_symbol' })).toBe(false);
    expect(isWriteStep({ service: 'leanctx', tool: 'ctx_read' })).toBe(false);
  });
});

describe('executeProcedure (review gate)', () => {
  it('creates ephemeral service clients when none are injected', async () => {
    const procedure = makeProcedure({
      steps: [
        { service: 'serena', tool: 'find_symbol' },
        { service: 'leanctx', tool: 'ctx_read' },
      ],
    });
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      fillArgs: async () => ({}),
      recordOutcome: false,
    });

    expect(result.ok).toBe(true);
    expect(result.results.map((step) => step.executed)).toEqual([true, true]);
    expect(serenaCalls).toEqual([
      {
        tool: 'activate_project',
        arguments: { project: dir },
        cwd: dir,
      },
      { tool: 'find_symbol', arguments: {}, cwd: dir },
    ]);
    expect(leanctxCalls).toEqual([{ tool: 'ctx_read', arguments: {}, cwd: dir }]);
  });

  it('auto-executes read-only steps and records success', async () => {
    const store = new ProcedureStore(dbPath);
    const procedure = seed(store);
    const serena = {
      callTool: vi.fn().mockResolvedValue({ rawText: 'found foo' }),
    };
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      fillArgs: async () => ({ name_path_pattern: 'foo' }),
      approve: async () => true,
      store,
    });
    expect(result.ok).toBe(true);
    expect(result.allExecuted).toBe(true);
    expect(result.pendingReview).toHaveLength(0);
    expect(result.results.map((r) => r.executed)).toEqual([true, true]);
    expect(serena.callTool).toHaveBeenCalledTimes(2);
    const stored = store.get(procedure.id);
    expect(stored!.successCount).toBe(1);
    store.close();
  });

  it('does NOT execute a write step when approval is denied (review gate)', async () => {
    const store = new ProcedureStore(dbPath);
    const procedure = seed(store);
    const serena = {
      callTool: vi.fn().mockResolvedValue({ rawText: 'found foo' }),
    };
    const approve = vi.fn().mockResolvedValue(false);
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      fillArgs: async () => ({}),
      approve,
      store,
    });
    // Read-only step ran; write step is blocked pending review.
    expect(result.pendingReview).toHaveLength(1);
    expect(result.allExecuted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.pendingReview[0]!.tool).toBe('replace_content');
    expect(approve).toHaveBeenCalledTimes(1);
    // The write tool was never invoked.
    const calls = serena.callTool.mock.calls.map((c) => (c[0] as { tool: string }).tool);
    expect(calls).not.toContain('replace_content');
    // Outcome not recorded as success (not fully executed).
    const stored = store.get(procedure.id);
    expect(stored!.successCount).toBe(0);
    store.close();
  });

  it('defaults to DENY when no approve callback is provided (safe default)', async () => {
    const procedure = makeProcedure();
    const serena = { callTool: vi.fn().mockResolvedValue({ rawText: 'ok' }) };
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      fillArgs: async () => ({}),
      recordOutcome: false,
    });
    expect(result.pendingReview).toHaveLength(1);
    expect(result.pendingReview[0]!.tool).toBe('replace_content');
    expect(result.ok).toBe(false);
  });

  it('reports a step error and records failure', async () => {
    const store = new ProcedureStore(dbPath);
    const procedure = seed(store, { steps: [{ service: 'serena', tool: 'find_symbol' }] });
    const serena = {
      callTool: vi.fn().mockResolvedValue({ rawText: 'Error executing tool find_symbol: boom' }),
    };
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      fillArgs: async () => ({}),
      store,
    });
    expect(result.ok).toBe(false);
    expect(result.results[0]!.error).toContain('Error executing tool');
    const stored = store.get(procedure.id);
    expect(stored!.failureCount).toBe(1);
    store.close();
  });

  it('verifies applied write matches the reviewed diff (apply-side diff-check)', async () => {
    const store = new ProcedureStore(dbPath);
    const procedure = seed(store, {
      steps: [{ service: 'serena', tool: 'replace_content', args: { relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' } }],
    });
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const serena = {
      callTool: vi.fn(async ({ arguments: a }: any) => {
        const p = join(dir, a.relative_path);
        const content = readFileSync(p, 'utf8').split(a.needle).join(a.repl);
        writeFileSync(p, content, 'utf8');
        return { rawText: 'OK' };
      }),
    };
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      approve: async () => true,
      fillArgs: async () => ({ relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' }),
      store,
    });
    expect(result.results[0]!.executed).toBe(true);
    expect(result.results[0]!.verified).toBe(true);
    expect(result.results[0]!.verifyNote).toContain('matches');
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('const y = 1;\n');
    store.close();
  });

  it('reports verified:false when applied content differs from the reviewed diff', async () => {
    const store = new ProcedureStore(dbPath);
    const procedure = seed(store, {
      steps: [{ service: 'serena', tool: 'replace_content', args: { relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' } }],
    });
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const serena = {
      // Simulate the tool writing something DIFFERENT than reviewed.
      callTool: vi.fn(async ({ arguments: a }: any) => {
        const p = join(dir, a.relative_path);
        writeFileSync(p, 'const z = 9;\n', 'utf8');
        return { rawText: 'OK' };
      }),
    };
    const result = await executeProcedure(procedure, {
      repoPath: dir,
      serena,
      approve: async () => true,
      fillArgs: async () => ({ relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' }),
      store,
    });
    expect(result.results[0]!.executed).toBe(true);
    expect(result.results[0]!.verified).toBe(false);
    expect(result.results[0]!.verifyNote).toContain('differs');
    store.close();
  });
});
