import { describe, expect, it } from 'vitest';
import {
  synthesizeLanguageStandard,
  synthesizeResponsePolicy,
} from '../src/classifier/synthesize';
import type { Classification } from '../src/classifier/schema';

function classification(task: Classification['task']): Classification {
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
    expect(synthesizeLanguageStandard(classification('documentation'))).toBe('asd_ste100');
  });

  it('uses Diátaxis for architecture and planning', () => {
    expect(synthesizeLanguageStandard(classification('architecture'))).toBe('diataxis');
    expect(synthesizeLanguageStandard(classification('planning'))).toBe('diataxis');
  });

  it('defaults to microsoft for everything else', () => {
    expect(synthesizeLanguageStandard(classification('debug'))).toBe('microsoft');
    expect(synthesizeLanguageStandard(classification('coding_new'))).toBe('microsoft');
  });
});

describe('synthesizeResponsePolicy language_standard', () => {
  it('always sets a language_standard on the response policy', () => {
    const policy = synthesizeResponsePolicy(classification('documentation'));
    expect(policy.language_standard).toBe('asd_ste100');
    expect(policy.directives).toContain('no_filler');
  });
});
