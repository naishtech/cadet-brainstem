import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcedureStore, getDefaultProcedurePath } from '../src/procedure/index';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-procedure-'));
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

describe('getDefaultProcedurePath', () => {
  it('reuses the memory db path by default (same database file)', () => {
    expect(getDefaultProcedurePath()).toMatch(/\.cadet-brainstem[/\\]memory\.db$/);
  });

  it('honours the CADET_BRAINSTEM_PROCEDURES override', () => {
    process.env.CADET_BRAINSTEM_PROCEDURES = 'C:/custom/procedures.db';
    expect(getDefaultProcedurePath()).toBe('C:/custom/procedures.db');
  });
});

function openStore(): { store: ProcedureStore; path: string } {
  const path = join(makeTempDir(), 'procedures.db');
  return { store: new ProcedureStore(path), path };
}

describe('ProcedureStore', () => {
  it('seeds a manually-authored procedure with source manually_seeded', () => {
    const { store } = openStore();
    const id = store.seedProcedure({
      triggerPattern: 'stage all changes, commit, open PR',
      keywords: ['commit', 'pr', 'push', 'stage'],
      steps: [{ service: 'serena', tool: 'find_symbol' }],
      riskTier: 'requires_review',
    });
    const procedure = store.get(id);
    expect(procedure).not.toBeNull();
    expect(procedure!.source).toBe('manually_seeded');
    expect(procedure!.keywords).toEqual(['commit', 'pr', 'push', 'stage']);
    expect(procedure!.steps[0]).toEqual({ service: 'serena', tool: 'find_symbol' });
    expect(procedure!.successCount).toBe(0);
    expect(procedure!.failureCount).toBe(0);
    store.close();
  });

  it('logObservedUsage forces source learned_from_usage and risk_tier requires_review', () => {
    const { store } = openStore();
    const id = store.logObservedUsage({
      triggerPattern: 'observed task',
      keywords: ['build'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
    });
    const procedure = store.get(id);
    expect(procedure!.source).toBe('learned_from_usage');
    expect(procedure!.riskTier).toBe('requires_review');
    store.close();
  });

  it('persists handoffShape when seeded and omits it when absent (task 47)', () => {
    const { store } = openStore();
    const withShape = store.seedProcedure({
      triggerPattern: 'create a file',
      keywords: ['create', 'file'],
      steps: [{ service: 'serena', tool: 'create_text_file' }],
      riskTier: 'requires_review',
      handoffShape: 'To create a file, ask create_text_file {relative_path, content}.',
    });
    const withoutShape = store.seedProcedure({
      triggerPattern: 'find a symbol',
      keywords: ['find', 'symbol'],
      steps: [{ service: 'serena', tool: 'find_symbol' }],
      riskTier: 'auto_execute',
    });
    expect(store.get(withShape)!.handoffShape).toContain('create_text_file');
    expect(store.get(withoutShape)!.handoffShape).toBeUndefined();
    store.close();
  });

  it('recordOutcome updates counters and last outcome', () => {
    const { store } = openStore();
    const id = store.seedProcedure({
      triggerPattern: 'run tests',
      keywords: ['test'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
      riskTier: 'auto_execute',
    });
    expect(store.recordOutcome(id, 'success')).toBe(true);
    expect(store.recordOutcome(id, 'failure')).toBe(true);
    const procedure = store.get(id)!;
    expect(procedure.successCount).toBe(1);
    expect(procedure.failureCount).toBe(1);
    expect(procedure.lastOutcome).toBe('failure');
    expect(procedure.lastUsedAt).not.toBeNull();
    expect(store.recordOutcome('missing-id', 'success')).toBe(false);
    store.close();
  });

  it('findMatches ranks by overlap quality', () => {
    const { store } = openStore();
    // Lower overlap (1 entity match).
    store.seedProcedure({
      triggerPattern: 'stage and commit',
      keywords: ['stage', 'commit', 'push'],
      steps: [{ service: 'serena', tool: 'find_symbol' }],
      riskTier: 'requires_review',
    });
    // Higher overlap (2 entity matches: commit + pr).
    store.seedProcedure({
      triggerPattern: 'open a pull request',
      keywords: ['commit', 'pr'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
      riskTier: 'requires_review',
    });

    const matches = store.findMatches(['commit', 'pr'], 'open a pull request and commit');
    expect(matches.length).toBe(2);
    // Higher overlap ranks first.
    expect(matches[0]!.triggerPattern).toBe('open a pull request');
    store.close();
  });

  it('findMatches returns unproven candidates but ranks them below proven ones', () => {
    const { store } = openStore();
    const provenId = store.seedProcedure({
      triggerPattern: 'run tests',
      keywords: ['test', 'run'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
      riskTier: 'auto_execute',
    });
    store.recordOutcome(provenId, 'success');
    store.seedProcedure({
      triggerPattern: 'run the formatter',
      keywords: ['run', 'format'],
      steps: [{ service: 'serena', tool: 'find_symbol' }],
      riskTier: 'requires_review',
    });
    const matches = store.findMatches(['run'], 'run something');
    expect(matches.length).toBe(2);
    // Proven one (run tests) ranks above unproven (formatter) on equal overlap.
    expect(matches[0]!.triggerPattern).toBe('run tests');
    expect(matches[1]!.triggerPattern).toBe('run the formatter');
    store.close();
  });

  it('findMatches returns empty for no overlap or no entities', () => {
    const { store } = openStore();
    store.seedProcedure({
      triggerPattern: 'run tests',
      keywords: ['test'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
      riskTier: 'auto_execute',
    });
    expect(store.findMatches([], 'anything')).toEqual([]);
    expect(store.findMatches(['unrelated'], 'nothing here')).toEqual([]);
    store.close();
  });

  it('count, list and clear work', () => {
    const { store } = openStore();
    expect(store.count()).toBe(0);
    store.seedProcedure({
      triggerPattern: 'a',
      keywords: ['a'],
      steps: [{ service: 'leanctx', tool: 'ctx_read' }],
      riskTier: 'auto_execute',
    });
    store.seedProcedure({
      triggerPattern: 'b',
      keywords: ['b'],
      steps: [{ service: 'serena', tool: 'find_symbol' }],
      riskTier: 'requires_review',
    });
    expect(store.count()).toBe(2);
    expect(store.list().length).toBe(2);
    expect(store.clear()).toBe(2);
    expect(store.count()).toBe(0);
    store.close();
  });
});
