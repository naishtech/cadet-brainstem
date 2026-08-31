import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  defaultPolicies,
  getDefaultStrategy,
  getStrategy,
  refineStrategy,
} from '../src/policy/index';
import type { Steering } from '../src/steering/index';

function makeSteering(task: string): Steering {
  return {
    task: task as Steering['task'],
    complexity: 'medium',
    risk: 'medium',
    // 'exhaustive' never narrows, so the task maps straight to its raw policy.
    context_need: 'exhaustive',
    precision: 'normal',
    entities: [],
    tool_plan: {},
    response_policy: { directives: [] },
  };
}

const debugSteering: Steering = {
  task: 'debug',
  complexity: 'high',
  risk: 'high',
  context_need: 'broad',
  precision: 'approximate',
  entities: [],
  tool_plan: {},
  response_policy: { directives: [] },
};

const questionSteering: Steering = {
  task: 'question',
  complexity: 'low',
  risk: 'low',
  context_need: 'minimal',
  precision: 'approximate',
  entities: [],
  tool_plan: {},
  response_policy: { directives: [] },
};

describe('PolicyEngine', () => {
  it('is deterministic for the same steering', () => {
    const engine = new PolicyEngine();
    expect(engine.getStrategy(debugSteering)).toEqual(
      engine.getStrategy(debugSteering),
    );
  });

  it('maps debug to the design-doc strategy', () => {
    const strategy = getStrategy(debugSteering);
    expect(strategy).toEqual(defaultPolicies.debug);
    expect(strategy.context_need).toBe('broad');
    expect(strategy.compression).toBe('conservative');
    expect(strategy.code_search).toBe('semantic');
    expect(strategy.terminal_output).toBe('error-focused');
    expect(strategy.leanctx_mode).toBe('cognitive');
  });

  it('maps question to aggressive compression', () => {
    const strategy = getStrategy(questionSteering);
    expect(strategy.compression).toBe('aggressive');
    expect(strategy.context_need).toBe('minimal');
    expect(strategy.code_search).toBe('none');
  });

  it('narrows a broad task policy when the steering asks for targeted context', () => {
    const strategy = getStrategy({
      ...makeSteering('review'),
      context_need: 'targeted',
    });
    expect(strategy.context_need).toBe('targeted');
    expect(strategy.leanctx_mode).toBe('map');
    // Task-specific knobs (compression / terminal_output / code_search) unchanged.
    expect(strategy.compression).toBe(defaultPolicies.review.compression);
    expect(strategy.terminal_output).toBe(defaultPolicies.review.terminal_output);
  });

  it('does not widen a minimal task policy when the steering asks for broad', () => {
    const strategy = getStrategy({
      ...makeSteering('question'),
      context_need: 'broad',
    });
    expect(strategy.context_need).toBe('minimal');
    expect(strategy.leanctx_mode).toBe(defaultPolicies.question.leanctx_mode);
  });

  it('refineStrategy caps the strategy by the steering context_need', () => {
    expect(refineStrategy({ ...defaultPolicies.review }, 'targeted').leanctx_mode).toBe(
      'map',
    );
    expect(refineStrategy({ ...defaultPolicies.review }, 'minimal').leanctx_mode).toBe(
      'reference',
    );
    expect(refineStrategy({ ...defaultPolicies.review }, 'exhaustive')).toEqual(
      defaultPolicies.review,
    );
  });

  it('gives documentation a context-appropriate (non-minimal) default', () => {
    expect(defaultPolicies.documentation.context_need).toBe('targeted');
    expect(defaultPolicies.documentation.code_search).toBe('semantic');
    expect(defaultPolicies.documentation.compression).toBe('normal');
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
      expect(engine.getStrategy(makeSteering(task))).toEqual(
        defaultPolicies[task],
      );
    }
  });

  it('falls back to the default policy for unknown task types', () => {
    const engine = new PolicyEngine();
    expect(engine.getStrategy(makeSteering('unknown'))).toEqual(
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
    expect(engine.getStrategy(debugSteering).compression).toBe('aggressive');
  });

  it('produces only plain data (no executable behavior)', () => {
    const strategy = getStrategy(debugSteering);
    for (const value of Object.values(strategy)) {
      expect(typeof value).not.toBe('function');
    }
  });
});
