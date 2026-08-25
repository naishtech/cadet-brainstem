import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  defaultPolicies,
  getDefaultStrategy,
  getStrategy,
} from '../src/policy/index';
import type { Classification } from '../src/classifier/index';

function makeClassification(task: string): Classification {
  return {
    task: task as Classification['task'],
    complexity: 'medium',
    risk: 'medium',
    context_need: 'targeted',
    precision: 'normal',
  };
}

const debugClassification: Classification = {
  task: 'debug',
  complexity: 'high',
  risk: 'high',
  context_need: 'broad',
  precision: 'approximate',
};

const questionClassification: Classification = {
  task: 'question',
  complexity: 'low',
  risk: 'low',
  context_need: 'minimal',
  precision: 'approximate',
};

describe('PolicyEngine', () => {
  it('is deterministic for the same classification', () => {
    const engine = new PolicyEngine();
    expect(engine.getStrategy(debugClassification)).toEqual(
      engine.getStrategy(debugClassification),
    );
  });

  it('maps debug to the design-doc strategy', () => {
    const strategy = getStrategy(debugClassification);
    expect(strategy).toEqual(defaultPolicies.debug);
    expect(strategy.context_need).toBe('broad');
    expect(strategy.compression).toBe('conservative');
    expect(strategy.code_search).toBe('semantic');
    expect(strategy.terminal_output).toBe('error-focused');
    expect(strategy.leanctx_mode).toBe('cognitive');
  });

  it('maps question to aggressive compression', () => {
    const strategy = getStrategy(questionClassification);
    expect(strategy.compression).toBe('aggressive');
    expect(strategy.context_need).toBe('minimal');
    expect(strategy.code_search).toBe('none');
  });

  it('covers all 13 task types', () => {
    const tasks: (keyof typeof defaultPolicies)[] = [
      'question',
      'coding_new',
      'coding_fix',
      'debug',
      'refactor',
      'test',
      'review',
      'architecture',
      'documentation',
      'investigation',
      'planning',
      'search',
      'configuration',
    ];
    const engine = new PolicyEngine();
    for (const task of tasks) {
      expect(engine.getStrategy(makeClassification(task))).toEqual(
        defaultPolicies[task],
      );
    }
  });

  it('falls back to the default policy for unknown task types', () => {
    const engine = new PolicyEngine();
    expect(engine.getStrategy(makeClassification('unknown'))).toEqual(
      defaultPolicies.default,
    );
  });

  it('returns the conservative default strategy for the fallback path', () => {
    expect(getDefaultStrategy()).toEqual(defaultPolicies.default);
  });

  it('uses injected custom policies', () => {
    const custom = {
      ...defaultPolicies,
      debug: {
        context_need: 'exhaustive' as const,
        compression: 'aggressive' as const,
        code_search: 'none' as const,
        terminal_output: 'normal' as const,
        leanctx_mode: 'raw' as const,
      },
    };
    const engine = new PolicyEngine(custom);
    expect(engine.getStrategy(debugClassification).compression).toBe('aggressive');
  });

  it('produces only plain data (no executable behavior)', () => {
    const strategy = getStrategy(debugClassification);
    for (const value of Object.values(strategy)) {
      expect(typeof value).not.toBe('function');
    }
  });
});
