/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTool, procedureReviewTool } from '../src/mcp';
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

function stubClassify(entities: string[]) {
  return async () => ({
    classification: {
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

  it('classifyTool returns a procedures handoff list for a matching request', async () => {
    const store = seededStore();
    const result = (await classifyTool(
      { task: 'gather and compress the relevant context for this file' },
      { classify: stubClassify(['context', 'compress', 'file']) as any, procedureStore: store },
    )) as any;

    expect(Array.isArray(result.procedures)).toBe(true);
    expect(result.procedures.map((p: any) => p.triggerPattern)).toContain(
      'Gather and compress relevant context',
    );
    store.close();
  });

  it('classifyTool returns no procedures when nothing matches', async () => {
    const store = seededStore();
    const result = (await classifyTool(
      { task: 'deploy the website to production' },
      { classify: stubClassify(['deploy', 'website']) as any, procedureStore: store },
    )) as any;

    expect(result.procedures).toEqual([]);
    store.close();
  });

  it('classifyTool includes review guidance for write procedures (review gate)', async () => {
    const store = seededStore();
    store.seedProcedure({
      triggerPattern: 'Replace content in a file',
      keywords: ['replace', 'content', 'edit', 'write'],
      steps: [{ service: 'serena', tool: 'replace_content', args: {} }],
      riskTier: 'requires_review',
    });
    const result = (await classifyTool(
      { task: 'replace content in a file' },
      { classify: stubClassify(['replace', 'content', 'edit']) as any, procedureStore: store },
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
});
