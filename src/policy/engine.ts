import { Classification } from '../classifier/schema';
import { loadConfig } from '../config/index';
import { OptimisationStrategy, Policies } from './schema';

/**
 * Deterministic policy engine (design doc §4).
 *
 * The LLM classifies; this engine decides. Given the same classification it
 * always returns the same strategy. It never executes tools or constructs
 * shell commands — it only maps a classification to a strategy.
 */
export class PolicyEngine {
  readonly policies: Policies;

  constructor(policies: Policies = loadConfig().policies) {
    this.policies = policies;
  }

  /** Deterministic: same classification → same strategy. */
  getStrategy(classification: Classification): OptimisationStrategy {
    const policy = this.policies[classification.task] ?? this.policies.default;
    return { ...policy };
  }

  /** Conservative strategy for the degraded/unavailable path (Task 05). */
  getDefaultStrategy(): OptimisationStrategy {
    return { ...this.policies.default };
  }
}

export function getStrategy(
  classification: Classification,
  policies: Policies = loadConfig().policies,
): OptimisationStrategy {
  return new PolicyEngine(policies).getStrategy(classification);
}

export function getDefaultStrategy(
  policies: Policies = loadConfig().policies,
): OptimisationStrategy {
  return new PolicyEngine(policies).getDefaultStrategy();
}
