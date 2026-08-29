import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookProcedureReview } from '../src/cli/commands/hook-procedure-review';
import { ProcedureStore } from '../src/procedure';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-pr-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function payload(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: dir,
    tool_name: 'procedure_apply',
    tool_input: {},
    ...overrides,
  });
}

function seed(store: ProcedureStore): string {
  return store.seedProcedure({
    triggerPattern: 'Replace content',
    keywords: ['replace'],
    steps: [{ service: 'serena', tool: 'replace_content', args: {} }],
    riskTier: 'requires_review',
  });
}

describe('runHookProcedureReview', () => {
  it('allows non-procedure_apply tools', async () => {
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () => payload({ tool_name: 'find_symbol' }),
      writeOut: (line) => out.push(line),
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows procedure_apply with approved:true', async () => {
    const store = new ProcedureStore(join(dir, 'p.db'));
    const id = seed(store);
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () =>
        payload({ tool_input: { procedure_id: id, repo: dir, approved: true } }),
      writeOut: (line) => out.push(line),
      store,
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    store.close();
  });

  it('denies procedure_apply without approval and surfaces the diff', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n', 'utf8');
    const store = new ProcedureStore(join(dir, 'p.db'));
    const id = seed(store);
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () =>
        payload({
          tool_input: {
            procedure_id: id,
            repo: dir,
            args: {
              replace_content: { relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' },
            },
          },
        }),
      writeOut: (line) => out.push(line),
      store,
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('-const x = 1;');
    expect(ctx).toContain('+const y = 1;');
    expect(ctx).toContain('approved:true');
    store.close();
  });

  it('denies unknown procedure with an error message', async () => {
    const store = new ProcedureStore(join(dir, 'p.db'));
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () => payload({ tool_input: { procedure_id: 'nope', repo: dir } }),
      writeOut: (line) => out.push(line),
      store,
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('nope');
    store.close();
  });
});
