import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHookProcedureReview } from '../src/cli/commands/hook-procedure-review';
import { setActiveProcedure } from '../src/cli/commands/hook-lifecycle';
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

  it('denies direct writes while a review-required procedure is active', async () => {
    setActiveProcedure('s1', {
      procedureId: 'procedure-1',
      triggerPattern: 'Create a file',
      repo: dir,
      write: true,
      expiresAt: Date.now() + 60_000,
    }, { stateDir: dir });
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () => payload({ session_id: 's1', tool_name: 'create_file' }),
      writeOut: (line) => out.push(line),
      stateDir: dir,
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('procedure_review');
  });

  it('denies shell redirection while a review-required procedure is active', async () => {
    setActiveProcedure('s2', {
      procedureId: 'procedure-1',
      triggerPattern: 'Create a file',
      repo: dir,
      write: true,
      expiresAt: Date.now() + 60_000,
    }, { stateDir: dir });
    const out: string[] = [];
    await runHookProcedureReview({
      readStdin: async () => payload({
        session_id: 's2',
        tool_name: 'run_in_terminal',
        tool_input: { command: 'echo content > output.txt' },
      }),
      writeOut: (line) => out.push(line),
      stateDir: dir,
    });
    expect(JSON.parse(out[0]!).hookSpecificOutput.permissionDecision).toBe('deny');
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
