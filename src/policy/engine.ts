import { Steering } from '../steering/schema';
import { loadConfig } from '../config/index';
import { OptimisationStrategy, Policies, StrategyContextNeed, LeanCtxMode } from './schema';

/**
 * Ordering of context need across both the steering enum and the strategy
 * enum ('structural' is policy-only; treated as broad-equivalent).
 */
const NEED_RANK: Record<StrategyContextNeed, number> = {
  minimal: 0,
  targeted: 1,
  broad: 2,
  structural: 2,
  exhaustive: 3,
};

/** LeanCTX mode escalation when the steering narrows the context need. */
const LEANCTX_BY_NEED: Record<
  Exclude<StrategyContextNeed, 'structural'>,
  LeanCtxMode
> = {
  minimal: 'reference',
  targeted: 'map',
  broad: 'cognitive',
  exhaustive: 'full',
};

/**
 * Cap the task-type default by the steering's own `context_need`. The
 * steering's read is authoritative on how much context to fetch: when it
 * asks for *less* than the static per-task default, narrow the strategy (and
 * downgrade the LeanCTX mode) rather than over-fetching. It never widens a
 * strategy beyond the task-type default.
 */
export function refineStrategy(
  strategy: OptimisationStrategy,
  contextNeed: Steering['context_need'],
): OptimisationStrategy {
  const askedRank = NEED_RANK[contextNeed];
  const baseRank = NEED_RANK[strategy.context_need];
  if (askedRank < baseRank) {
    return {
      ...strategy,
      context_need: contextNeed,
      leanctx_mode: LEANCTX_BY_NEED[contextNeed],
    };
  }
  return strategy;
}

/**
 * Deterministic policy engine (design doc §4).
 *
 * The LLM classifies; this engine decides. Given the same steering it
 * always returns the same strategy. It never executes tools or constructs
 * shell commands — it only maps a steering to a strategy.
 */
export class PolicyEngine {
  readonly policies: Policies;

  constructor(policies: Policies = loadConfig().policies) {
    this.policies = policies;
  }

  /** Deterministic: same steering → same strategy. */
  getStrategy(steering: Steering): OptimisationStrategy {
    const policy = this.policies[steering.task] ?? this.policies.default;
    return refineStrategy({ ...policy }, steering.context_need);
  }

  /** Conservative strategy for the degraded/unavailable path (Task 05). */
  getDefaultStrategy(): OptimisationStrategy {
    return { ...this.policies.default };
  }
}

export function getStrategy(
  steering: Steering,
  policies: Policies = loadConfig().policies,
): OptimisationStrategy {
  return new PolicyEngine(policies).getStrategy(steering);
}

export function getDefaultStrategy(
  policies: Policies = loadConfig().policies,
): OptimisationStrategy {
  return new PolicyEngine(policies).getDefaultStrategy();
}
