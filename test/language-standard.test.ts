import { describe, expect, it } from 'vitest';
import {
  synthesizeLanguageStandard,
  synthesizeResponsePolicy,
} from '../src/steering/synthesize';
import type { Steering } from '../src/steering/schema';

function steering(task: Steering['task']): Steering {
  return {
    task,
    complexity: 'medium',
    risk: 'low',
    context_need: 'broad',
    precision: 'normal',
    entities: ['docs'],
    confidence: 0.8,
    needs_more_context: false,
    tool_plan: { recommended_tools: [] },
    response_policy: { directives: [] },
  };
}

describe('synthesizeLanguageStandard', () => {
  it('uses STE (asd_ste100) for documentation work', () => {
    expect(synthesizeLanguageStandard(steering('documentation'))).toBe('asd_ste100');
  });

  it('uses Diátaxis for architecture and planning', () => {
    expect(synthesizeLanguageStandard(steering('architecture'))).toBe('diataxis');
    expect(synthesizeLanguageStandard(steering('planning'))).toBe('diataxis');
  });

  it('defaults to microsoft for everything else', () => {
    expect(synthesizeLanguageStandard(steering('debug'))).toBe('microsoft');
    expect(synthesizeLanguageStandard(steering('coding_new'))).toBe('microsoft');
  });
});

describe('synthesizeResponsePolicy language_standard', () => {
  it('always sets a language_standard on the response policy', () => {
    const policy = synthesizeResponsePolicy(steering('documentation'));
    expect(policy.language_standard).toBe('asd_ste100');
    expect(policy.directives).toContain('no_filler');
  });
});
