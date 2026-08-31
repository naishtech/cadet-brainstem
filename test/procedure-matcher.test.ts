/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { steerTool, procedureApplyTool, procedureReviewTool } from '../src/mcp';
import { ProcedureStore } from '../src/procedure';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proc-match-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.CADET_BRAINSTEM_PROCEDURES;
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_PROCEDURES;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A store pre-seeded with the read-only sample procedures. */
function seededStore(): ProcedureStore {
  const store = new ProcedureStore(join(makeTempDir(), 'procedures.db'));
  store.seedProcedure({
    triggerPattern: 'Gather and compress relevant context',
    keywords: ['context', 'read', 'compress', 'file', 'ctx'],
    steps: [{ service: 'leanctx', tool: 'ctx_read', args: { mode: 'map' } }],
    riskTier: 'auto_execute',
  });
  store.seedProcedure({
    triggerPattern: 'Find symbols for a change',
    keywords: ['symbol', 'find', 'reference', 'rename', 'serena'],
    steps: [{ service: 'serena', tool: 'find_symbol' }],
    riskTier: 'auto_execute',
  });
  store.seedProcedure({
    triggerPattern: 'Compress a command output',
    keywords: ['compress', 'command', 'output', 'rtk', 'shell'],
    steps: [{ service: 'rtk', tool: 'compress_command_output' }],
    riskTier: 'auto_execute',
  });
  store.seedProcedure({
    triggerPattern: 'Summarize project structure',
    keywords: ['structure', 'explore', 'tree', 'layout', 'project'],
    steps: [{ service: 'leanctx', tool: 'ctx_explore' }],
    riskTier: 'auto_execute',
  });
  return store;
}

function stubSteer(entities: string[]) {
  return async () => ({
    steering: {
      task: 'search',
      complexity: 'low',
      risk: 'low',
      context_need: 'targeted',
      precision: 'normal',
      entities,
      tool_plan: {},
      response_policy: { directives: ['compact'] },
    },
    degraded: false,
  });
}

describe('procedure matcher (repeatable)', () => {
  it('findMatches returns the matching read-only procedure for a sample request', () => {
    const store = seededStore();
    const matches = store.findMatches(
      ['context', 'compress', 'file'],
      'gather and compress the relevant context for this file',
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.triggerPattern).toBe('Gather and compress relevant context');
    expect(matches[0]!.steps[0]!.service).toBe('leanctx');
    store.close();
  });

  it('steerTool returns a procedures handoff list for a matching request', async () => {
    const store = seededStore();
    const result = (await steerTool(
      { task: 'gather and compress the relevant context for this file' },
      { steer: stubSteer(['context', 'compress', 'file']) as any, procedureStore: store },
    )) as any;

    expect(Array.isArray(result.procedures)).toBe(true);
    expect(result.procedures.map((p: any) => p.triggerPattern)).toContain(
      'Gather and compress relevant context',
    );
    store.close();
  });

  it('steerTool adds a procedure_apply directive to the tool_plan when a procedure matches', async () => {
    const store = seededStore();
    const result = (await steerTool(
      { task: 'gather and compress the relevant context for this file' },
      { steer: stubSteer(['context', 'compress', 'file']) as any, procedureStore: store },
    )) as any;

    const rec = result.tool_plan.recommended_tools ?? [];
    const pa = rec.find((t: any) => t.name === 'procedure_apply');
    expect(pa).toBeDefined();
    expect(pa.intent).toContain('Gather and compress relevant context');
    store.close();
  });

  it('steerTool does not add procedure_apply when no procedure matches', async () => {
    const store = seededStore();
    const result = (await steerTool(
      { task: 'deploy the website to production' },
      { steer: stubSteer(['deploy', 'website']) as any, procedureStore: store },
    )) as any;

    const rec = result.tool_plan.recommended_tools ?? [];
    expect(rec.some((t: any) => t.name === 'procedure_apply')).toBe(false);
    store.close();
  });

  it('steerTool returns no procedures when nothing matches', async () => {
    const store = seededStore();
    const result = (await steerTool(
      { task: 'deploy the website to production' },
      { steer: stubSteer(['deploy', 'website']) as any, procedureStore: store },
    )) as any;

    expect(result.procedures).toEqual([]);
    store.close();
  });

  it('steerTool includes review guidance for write procedures (review gate)', async () => {
    const store = seededStore();
    store.seedProcedure({
      triggerPattern: 'Replace content in a file',
      keywords: ['replace', 'content', 'edit', 'write'],
      steps: [{ service: 'serena', tool: 'replace_content', args: {} }],
      riskTier: 'requires_review',
    });
    const result = (await steerTool(
      { task: 'replace content in a file' },
      { steer: stubSteer(['replace', 'content', 'edit']) as any, procedureStore: store },
    )) as any;

    expect(Array.isArray(result.procedures_review)).toBe(true);
    expect(result.procedures_review.map((r: any) => r.triggerPattern)).toContain(
      'Replace content in a file',
    );
    expect(result.procedures_review[0]!.note).toContain('Do NOT auto-execute');
    store.close();
  });

  it('procedure_review returns no reviews for a read-only procedure (no Ollama call)', async () => {
    const store = seededStore();
    const p = store.list()[0]!;
    const result = (await procedureReviewTool(
      { procedure_id: p.id, repo: process.cwd() },
      { procedureStore: store },
    )) as any;
    expect(Array.isArray(result.reviews)).toBe(true);
    expect(result.reviews).toEqual([]);
    store.close();
  });

  it('procedure_review returns an error for an unknown procedure', async () => {
    const store = seededStore();
    const result = (await procedureReviewTool(
      { procedure_id: 'does-not-exist', repo: process.cwd() },
      { procedureStore: store },
    )) as any;
    expect(result.error).toContain('does-not-exist');
    store.close();
  });

  it('procedure_apply refuses to apply when approved !== true (review gate)', async () => {
    const store = seededStore();
    const p = store.list()[0]!;
    const result = (await procedureApplyTool(
      { procedure_id: p.id, repo: process.cwd(), approved: false },
      { procedureStore: store },
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approved must be true');
    store.close();
  });

  it('procedure_apply returns an error for an unknown procedure', async () => {
    const store = seededStore();
    const result = (await procedureApplyTool(
      { procedure_id: 'nope', repo: process.cwd(), approved: true },
      { procedureStore: store },
    )) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nope');
    store.close();
  });

  it('procedure_apply executes a procedure when approved, using injected adapters', async () => {
    const store = seededStore();
    const p = store.list()[0]!; // read-only ctx_read (leanctx)
    const serena = { callTool: async () => ({ rawText: 'ok' }) };
    const leanctx = { callTool: async () => ({ rawText: 'ctx ok' }) };
    const result = (await procedureApplyTool(
      { procedure_id: p.id, repo: process.cwd(), approved: true },
      {
        procedureStore: store,
        procedureThinkEachStep: false,
        procedureFillArgs: async () => ({ path: 'src/procedure/store.ts' }),
        procedureSerena: serena,
        procedureLeanctx: leanctx,
      },
    )) as any;
    expect(result.ok).toBe(true);
    expect(result.allExecuted).toBe(true);
    expect(result.results[0]!.executed).toBe(true);
    store.close();
  });
});
