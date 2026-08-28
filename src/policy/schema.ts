import { z } from 'zod';

export const compressionSchema = z.enum(['conservative', 'normal', 'aggressive']);
export type Compression = z.infer<typeof compressionSchema>;

export const codeSearchSchema = z.enum(['semantic', 'none']);
export type CodeSearch = z.infer<typeof codeSearchSchema>;

export const terminalOutputSchema = z.enum(['error-focused', 'normal']);
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;

/** Strategy context need — adds 'structural' beyond the classifier enum (design doc §4 REFACTOR). */
export const strategyContextNeedSchema = z.enum([
  'minimal',
  'targeted',
  'broad',
  'exhaustive',
  'structural',
]);
export type StrategyContextNeed = z.infer<typeof strategyContextNeedSchema>;

export const leanCtxModeSchema = z.enum([
  'full',
  'raw',
  'lines',
  'diff',
  'reference',
  'signatures',
  'map',
  'cognitive',
  'task',
  'density',
  'aggressive',
]);
export type LeanCtxMode = z.infer<typeof leanCtxModeSchema>;

export const policySchema = z.object({
  context_need: strategyContextNeedSchema,
  compression: compressionSchema,
  code_search: codeSearchSchema,
  terminal_output: terminalOutputSchema,
  leanctx_mode: leanCtxModeSchema,
  leanctx_budget: z.number().int().positive().optional(),
});
export type Policy = z.infer<typeof policySchema>;

/** Strategy output of the policy engine — same shape as a policy. */
export type OptimisationStrategy = Policy;

/**
 * Policies keyed by task type (all 13) plus a required `default`.
 * Explicit keys so every task type must have a policy and `default` is
 * guaranteed present.
 */
export const policiesSchema = z.object({
  default: policySchema,
  question: policySchema,
  coding_new: policySchema,
  coding_fix: policySchema,
  debug: policySchema,
  refactor: policySchema,
  test: policySchema,
  review: policySchema,
  architecture: policySchema,
  documentation: policySchema,
  investigation: policySchema,
  planning: policySchema,
  search: policySchema,
  configuration: policySchema,
});
export type Policies = z.infer<typeof policiesSchema>;

/**
 * Sensible default policies for all 13 task types + a conservative `default`.
 * Lives in config (`config.yaml` → `policies`) so users can override them.
 */
export const defaultPolicies: Policies = {
  // Conservative fallback (used when a task type is unknown / degraded).
  default: {
    context_need: 'broad',
    compression: 'conservative',
    code_search: 'semantic',
    terminal_output: 'error-focused',
    leanctx_mode: 'cognitive',
  },
  question: {
    context_need: 'minimal',
    compression: 'aggressive',
    code_search: 'none',
    terminal_output: 'normal',
    leanctx_mode: 'reference',
  },
  coding_new: {
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'map',
  },
  coding_fix: {
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'task',
  },
  debug: {
    context_need: 'broad',
    compression: 'conservative',
    code_search: 'semantic',
    terminal_output: 'error-focused',
    leanctx_mode: 'cognitive',
  },
  refactor: {
    context_need: 'structural',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'map',
  },
  test: {
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'task',
  },
  review: {
    context_need: 'broad',
    compression: 'conservative',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'full',
  },
  architecture: {
    context_need: 'broad',
    compression: 'conservative',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'map',
  },
  documentation: {
    // Docs work usually needs repo + symbol access (and often project-specific
    // MCP inspection), so 'minimal/aggressive/none' was far too low and forced
    // an absurd 'strategy' for real documentation tasks.
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'map',
  },
  investigation: {
    context_need: 'broad',
    compression: 'normal',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'cognitive',
  },
  planning: {
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'none',
    terminal_output: 'normal',
    leanctx_mode: 'task',
  },
  search: {
    context_need: 'minimal',
    compression: 'aggressive',
    code_search: 'semantic',
    terminal_output: 'normal',
    leanctx_mode: 'reference',
  },
  configuration: {
    context_need: 'targeted',
    compression: 'normal',
    code_search: 'none',
    terminal_output: 'normal',
    leanctx_mode: 'lines',
  },
};
