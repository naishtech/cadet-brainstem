import { describe, expect, it } from 'vitest';
import {
  synthesizeEvidencePlan,
  synthesizePlans,
  synthesizeToolPlan,
} from '../src/classifier';
import type { Classification } from '../src/classifier';

function makeClassification(overrides: Partial<Classification>): Classification {
  return {
    task: 'debug',
    complexity: 'medium',
    risk: 'medium',
    context_need: 'broad',
    precision: 'normal',
    entities: ['loader'],
    tool_plan: {},
    response_policy: { directives: [] },
    ...overrides,
  };
}

describe('synthesizeToolPlan', () => {
  it('returns an empty plan for context_need=minimal (no tools for simple questions)', () => {
    const plan = synthesizeToolPlan(makeClassification({ context_need: 'minimal' }));
    expect(plan.recommended_tools).toEqual([]);
  });

  it('adds the debug rule tool from a matching entity', () => {
    const plan = synthesizeToolPlan(
      makeClassification({ entities: ['checkout', 'error handler'] }),
    );
    expect((plan.recommended_tools ?? []).map((t) => t.name)).toContain('find_relevant_symbols');
  });

  it('adds optimize_context for documentation/planning entities', () => {
    const plan = synthesizeToolPlan(
      makeClassification({ task: 'documentation', entities: ['blueprints', 'document'] }),
    );
    expect((plan.recommended_tools ?? []).map((t) => t.name)).toEqual(
      expect.arrayContaining(['find_relevant_symbols', 'optimize_context']),
    );
  });

  it('does not over-trigger compress_command_output from the noun "command"', () => {
    const plan = synthesizeToolPlan(
      makeClassification({ task: 'documentation', entities: ['CLI commands', 'README'] }),
    );
    expect((plan.recommended_tools ?? []).map((t) => t.name)).not.toContain('compress_command_output');
  });

  it('falls back to a baseline find_relevant_symbols when nothing matches', () => {
    const plan = synthesizeToolPlan(makeClassification({ entities: ['unknown-thing'] }));
    expect((plan.recommended_tools ?? []).map((t) => t.name)).toEqual(['find_relevant_symbols']);
  });
});

describe('synthesizeEvidencePlan', () => {
  it('returns undefined for context_need=minimal', () => {
    expect(synthesizeEvidencePlan(makeClassification({ context_need: 'minimal' }))).toBeUndefined();
  });

  it('emits one query per entity with an id (required for tracing)', () => {
    const ep = synthesizeEvidencePlan(makeClassification({ entities: ['loader', 'payment'] }));
    expect(ep).toBeDefined();
    expect(ep!.prioritized_queries.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(ep!.prioritized_queries[0]).toMatchObject({
      query: 'loader',
      sources: ['file_search'],
    });
  });

  it('omits evidence_plan when there are no entities', () => {
    expect(synthesizeEvidencePlan(makeClassification({ entities: [] }))).toBeUndefined();
  });
});

describe('synthesizePlans', () => {
  it('fills tool_plan, evidence_plan, response_policy and reminders on a lean classification', () => {
    const lean = makeClassification({
      task: 'debug',
      context_need: 'broad',
      entities: ['checkout', 'payment'],
    });
    const full = synthesizePlans(lean);
    expect(full.entities).toEqual(['checkout', 'payment']);
    expect((full.tool_plan.recommended_tools ?? []).length).toBeGreaterThan(0);
    expect(full.evidence_plan).toBeDefined();
    // debug is exploratory -> preserve_evidence + progressive_disclosure
    expect(full.response_policy.directives).toContain('preserve_evidence');
    expect(full.response_policy.directives).toContain('follow_tool_plan');
    expect((full.reminders ?? []).length).toBe((full.tool_plan.recommended_tools ?? []).length);
  });
});
