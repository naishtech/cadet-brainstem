import {
  Classification,
  EvidencePlan,
  EvidenceQuery,
  LanguageStandard,
  RecommendedTool,
  Reminder,
  RESPONSE_POLICY_KEYS,
  ResponsePolicy,
  ResponsePolicyKey,
  ToolName,
  ToolPlan,
} from './schema';

/**
 * Deterministic synthesis of the token-saving fields (`tool_plan`,
 * `evidence_plan`, `response_policy`, `reminders`) from the lean LLM
 * classification (`task`, `context_need`, `entities`).
 *
 * Rationale (from testing): the local Qwen model reliably produces the core
 * classification + entity extraction fast and correctly, but is SLOW AND
 * GENERIC when asked to reason about tool/evidence selection. So we stop asking
 * it. These fields are computed here in code from a curated keyword → tool map,
 * which is faster (no second reasoning pass) and more specific (real tool names,
 * real entities) than the model's output.
 *
 * This module is plain deterministic code — it never calls the LLM.
 */

interface ToolRule {
  /** Case-insensitive substrings matched against the joined `entities`. */
  keywords: string[];
  tool: ToolName;
  intent: string;
  priority: number;
}

/**
 * Curated keyword → real-tool map. Only references tools that actually exist
 * (`TOOL_NAMES`). Generic software-engineering keywords — no project-specific
 * tool names. A request can match multiple rules; all matches are kept and
 * sorted by priority (cheapest-first).
 */
const TOOL_RULES: ToolRule[] = [
  {
    keywords: ['debug', 'bug', 'crash', 'error', 'exception', 'trace', 'stack', 'fail'],
    tool: 'find_relevant_symbols',
    intent: 'locate the code/symbols involved in the issue',
    priority: 1,
  },
  {
    keywords: ['refactor', 'restructure', 'clean', 'improve'],
    tool: 'find_relevant_symbols',
    intent: 'locate the code to restructure',
    priority: 1,
  },
  {
    keywords: ['test', 'testing', 'spec', 'assert'],
    tool: 'find_relevant_symbols',
    intent: 'locate the code under test',
    priority: 1,
  },
  {
    keywords: ['document', 'doc', 'readme', 'comment', 'write', 'guide', 'explain'],
    tool: 'optimize_context',
    intent: 'pull the relevant component/file context to document',
    priority: 2,
  },
  {
    keywords: ['architecture', 'design', 'plan', 'overview'],
    tool: 'optimize_context',
    intent: 'extract the relevant architecture/context',
    priority: 2,
  },
  {
    keywords: ['implement', 'add', 'feature', 'create', 'new'],
    tool: 'find_relevant_symbols',
    intent: 'locate where the new code should go',
    priority: 2,
  },
  {
    // Action-oriented only: "CLI commands" (documenting them) should NOT
    // trigger shell compression, so avoid the broad nouns `command`/`output`.
    keywords: ['build', 'compile', 'run', 'execute', 'deploy', 'shell', 'docker', 'log', 'ci', 'pipeline'],
    tool: 'compress_command_output',
    intent: 'compress noisy command/build/test output for cheap analysis',
    priority: 1,
  },
];

/** Synthesize `tool_plan` deterministically from entities + context_need. */
export function synthesizeToolPlan(c: Classification): ToolPlan {
  // Simple questions need no tools.
  if (c.context_need === 'minimal') {
    return { recommended_tools: [] };
  }
  const matched = new Map<ToolName, RecommendedTool>();
  const add = (tool: ToolName, intent: string, priority: number): void => {
    const existing = matched.get(tool);
    if (existing === undefined) {
      matched.set(tool, { name: tool, intent, priority });
    } else {
      existing.priority = Math.min(existing.priority, priority);
    }
  };

  const haystack = c.entities.join(' ').toLowerCase();
  for (const rule of TOOL_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) {
      add(rule.tool, rule.intent, rule.priority);
    }
  }
  // Baseline: any non-trivial task needs at least symbol search.
  if (!matched.has('find_relevant_symbols')) {
    add('find_relevant_symbols', 'locate the relevant symbols across the project', 1);
  }
  const recommended_tools = [...matched.values()].sort((a, b) => a.priority - b.priority);
  return { recommended_tools };
}

/** Synthesize the scope string from the task + matched entities. */
function synthesizeScope(c: Classification): string {
  const names = c.entities.slice(0, 5).join(', ');
  return names.length > 0 ? `${c.task}: ${names}` : c.task;
}

/** Synthesize `evidence_plan` — one query per entity. Returns undefined if none. */
export function synthesizeEvidencePlan(c: Classification): EvidencePlan | undefined {
  if (c.context_need === 'minimal') {
    return undefined;
  }
  const entities = c.entities.map((e) => e.trim()).filter((e) => e.length > 0);
  if (entities.length === 0) {
    return undefined;
  }
  const prioritized_queries: EvidenceQuery[] = entities.slice(0, 8).map((entity, i) => ({
    id: `q${i + 1}`, // id is required downstream for tracing
    query: entity,
    sources: ['file_search'],
  }));
  return { prioritized_queries, scope: synthesizeScope(c) };
}

/**
 * Deterministic documentation language standard from the task. STE
 * (ASD-STE100, controlled language) is chosen for documentation/runbook-style
 * work — maximum clarity, minimal ambiguity. Architecture/planning lean toward
 * Diátaxis (reader-mode structure); everything else uses the house style.
 */
export function synthesizeLanguageStandard(c: Classification): LanguageStandard {
  switch (c.task) {
    case 'documentation':
      return 'asd_ste100';
    case 'architecture':
    case 'planning':
      return 'diataxis';
    default:
      return 'microsoft';
  }
}

/** Synthesize response directives deterministically from task/context. */
export function synthesizeResponsePolicy(c: Classification): ResponsePolicy {
  const directives: ResponsePolicyKey[] = [];
  const exploratory = ['debug', 'review', 'investigation'].includes(c.task);
  if (exploratory) {
    directives.push('preserve_evidence', 'progressive_disclosure');
  } else {
    directives.push('delta_only', 'no_filler', 'no_tool_narration', 'no_unnecessary_formatting');
  }
  if ((c.tool_plan?.recommended_tools?.length ?? 0) > 0) {
    directives.push('follow_tool_plan');
  }
  return {
    directives: [...new Set(directives)],
    language_standard: synthesizeLanguageStandard(c),
  };
}

/** Synthesize reminders from the recommended tools. */
export function synthesizeReminders(c: Classification): Reminder[] {
  const tools = c.tool_plan?.recommended_tools ?? [];
  return tools.slice(0, 8).map((t) => ({
    tool: t.name,
    message: `${t.intent}; use ${t.name}.`,
  }));
}

/**
 * Fill the lean model classification with synthesized token-saving fields.
 * The model only produces `task/complexity/risk/context_need/entities/
 * confidence/needs_more_context`; this returns the full classification with
 * `tool_plan`, `evidence_plan`, `response_policy` and `reminders` computed in
 * code.
 */
export function synthesizePlans(c: Classification): Classification {
  const toolPlan = synthesizeToolPlan(c);
  const evidencePlan = synthesizeEvidencePlan(c);
  const withPlans: Classification = {
    ...c,
    tool_plan: toolPlan,
    response_policy: synthesizeResponsePolicy({ ...c, tool_plan: toolPlan }),
  };
  if (evidencePlan !== undefined) {
    withPlans.evidence_plan = evidencePlan;
  }
  withPlans.reminders = synthesizeReminders(withPlans);
  return withPlans;
}

/** Re-export so callers can reference the available recommendation vocabulary. */
export { RESPONSE_POLICY_KEYS };
