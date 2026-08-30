/**
 * Live execution bridge + review gate (task 49).
 *
 * Takes a matched `Procedure` and a REAL repo path, and drives the local LLM to
 * execute its steps against that repo via the Serena / LeanCTX adapters.
 *
 * - Read-only steps (`auto_execute`): executed directly.
 * - Write steps (`requires_review`, e.g. create_text_file / replace_content /
 *   insert_after_symbol / ctx_patch): GATED behind an `approve` callback.
 *   They are NOT executed unless approved — this is the review gate that makes
 *   running procedures on a real repo safe.
 *
 * Outcomes are recorded in the `ProcedureStore` track record so `findMatches`
 * can rank proven procedures higher.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcedureStore, type Procedure, type ProcedureStep } from './index';
import { buildWriteDiff } from './review';

/** Serena/LeanCTX tools that mutate files (or shell) — these need review. */
const WRITE_TOOLS = new Set([
  'create_text_file',
  'replace_content',
  'replace_in_files',
  'replace_symbol_body',
  'insert_after_symbol',
  'insert_before_symbol',
  'rename_symbol',
  'safe_delete_symbol',
  'replace_lines',
  'delete_lines',
  'insert_lines',
  'insert_at_line',
  'execute_shell_command',
  'ctx_patch',
  'ctx_shell',
]);

/** True when a step mutates the repo (needs the review gate). */
export function isWriteStep(step: ProcedureStep): boolean {
  return WRITE_TOOLS.has(step.tool);
}

/**
 * Required/expected parameter names per tool, so `defaultFillArgs` can prompt
 * the local LLM with the correct shape (matches the confirmed templates).
 */
const TOOL_ARG_HINTS: Record<string, string[]> = {
  // serena
  find_symbol: ['name_path_pattern'],
  find_referencing_symbols: ['name_path', 'relative_path'],
  find_implementations: ['name_path', 'relative_path'],
  find_declaration: ['relative_path', 'regex'],
  get_symbols_overview: ['relative_path'],
  get_diagnostics_for_file: ['relative_path'],
  read_file: ['relative_path'],
  search_for_pattern: ['substring_pattern', 'relative_path'],
  create_text_file: ['relative_path', 'content'],
  replace_content: ['relative_path', 'needle', 'repl', 'mode'],
  replace_in_files: ['relative_path', 'needle', 'repl', 'mode'],
  insert_after_symbol: ['name_path', 'relative_path', 'body'],
  insert_before_symbol: ['name_path', 'relative_path', 'body'],
  rename_symbol: ['name_path', 'new_name'],
  safe_delete_symbol: ['name_path'],
  // leanctx
  ctx_read: ['path'],
  ctx_tree: ['path'],
  ctx_compose: ['task', 'path'],
  ctx_glob: ['pattern', 'path'],
  ctx_search: ['action', 'pattern', 'path'],
  ctx_callgraph: ['action', 'symbol'],
  ctx_patch: ['op', 'path'],
  ctx_shell: ['command'],
};

/** Parameter names expected by a tool (empty → unknown, prompt generically). */
function argHintsFor(tool: string): string[] {
  return TOOL_ARG_HINTS[tool] ?? [];
}

export interface ExecuteStepResult {
  service: string;
  tool: string;
  write: boolean;
  verdict: 'auto' | 'review';
  executed: boolean;
  approved?: boolean;
  output?: string;
  error?: string;
  /** Apply-side diff check: true when the applied file matches the reviewed diff. */
  verified?: boolean;
  verifyNote?: string;
}

export interface ExecuteProcedureResult {
  procedureId: string;
  ok: boolean;
  /** True when every step ran (no step was blocked on review). */
  allExecuted: boolean;
  results: ExecuteStepResult[];
  pendingReview: ExecuteStepResult[];
}

export interface ExecuteProcedureOptions {
  /** Absolute path of the real repo to run against. */
  repoPath: string;
  /**
   * Review gate for write steps. Called with the step + its resolved args;
   * return true to approve execution, false to skip (stays pendingReview).
   * Default: deny (safe) — a caller must explicitly opt in to run writes.
   */
  approve?: (step: ProcedureStep, args: Record<string, unknown>) => Promise<boolean> | boolean;
  /** Optional per-step callback (progress / reporting). */
  onStep?: (result: ExecuteStepResult) => void;
  /** Fill the tool's parameters for a step. Defaults to the local LLM. */
  fillArgs?: (step: ProcedureStep, repoPath: string) => Promise<Record<string, unknown>>;
  /** Injectable adapters (for tests / reuse). Created lazily if omitted. */
  serena?: { callTool(args: unknown): Promise<{ rawText: string; degraded?: boolean }> };
  leanctx?: { callTool(args: unknown): Promise<{ rawText: string; degraded?: boolean }> };
  /** Record outcomes in the store (default true). */
  recordOutcome?: boolean;
  store?: ProcedureStore;
}

/** Default param filler: ask the local LLM (intent-grounded, like the harness). */
export async function defaultFillArgs(
  step: ProcedureStep,
  repoPath: string,
  handoffShape?: string,
): Promise<Record<string, unknown>> {
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  // Lazily import to avoid a hard classifier dependency at module load.
  const { resolveBaseModel } = await import('../classifier');
  const hints = argHintsFor(step.tool);
  const response = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolveBaseModel(),
      messages: [
        {
          role: 'user',
          content: [
            `You must call the ${step.service} tool "${step.tool}" on the project at ${repoPath}.`,
            hints.length > 0 ? `The tool expects these parameters: ${hints.join(', ')}.` : '',
            handoffShape !== undefined ? `Handoff shape (the tested format to follow): ${handoffShape}` : '',
            step.args && Object.keys(step.args).length > 0
              ? `The intended parameter values are: ${JSON.stringify(step.args)}. Use them exactly.`
              : '',
            `Respond with JSON: {"arguments": {<parameters>}}.`,
          ].filter(Boolean).join('\n'),
        },
      ],
      stream: false,
      format: { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'] },
      think: false,
      options: { temperature: 0, num_predict: 600 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return (JSON.parse(data.message?.content ?? '{}') as { arguments?: Record<string, unknown> }).arguments ?? {};
}

/** Reduce path-like args to be repo-relative (the local LLM over-specifies paths). */
function normalizeArgs(args: Record<string, unknown>, repoPath: string): Record<string, unknown> {
  const relRepo = repoPath.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && (k === 'file' || k === 'path' || k === 'relative_path' || k === 'file_name')) {
      let s = v.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]+/g, '/');
      if (s.startsWith(relRepo + '/')) s = s.slice(relRepo.length + 1);
      s = s.replace(/^[\\/]+/, '');
      out[k] = s;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function invoke(
  adapter: { callTool(args: unknown): Promise<{ rawText: string; degraded?: boolean }> },
  service: string,
  tool: string,
  args: Record<string, unknown>,
  repoPath: string,
): Promise<string> {
  const r = await adapter.callTool({ tool, arguments: normalizeArgs(args, repoPath), cwd: repoPath });
  return r.rawText ?? '';
}

/**
 * Execute a procedure's steps against a real repo, gating write steps behind
 * the `approve` callback. Records the overall outcome in the store.
 */
export async function executeProcedure(
  procedure: Procedure,
  options: ExecuteProcedureOptions,
): Promise<ExecuteProcedureResult> {
  const repoPath = options.repoPath;
  // Default arg-filler threads the procedure's stored handoffShape so the local
  // LLM fills args using the tested format (task 47 wiring).
  const fillArgs =
    options.fillArgs ??
    ((step: ProcedureStep, repoPath: string) => defaultFillArgs(step, repoPath, procedure.handoffShape));
  const approve = options.approve ?? (() => false); // default: deny writes
  const recordOutcome = options.recordOutcome ?? true;
  const store = options.store ?? new ProcedureStore();
  const serena = options.serena;
  const leanctx = options.leanctx;

  // Lazily create + activate a real Serena adapter if any serena step needs it.
  let localSerena = serena;
  if (!localSerena && procedure.steps.some((s) => s.service === 'serena')) {
    const { SerenaAdapter } = await import('../integrations/serena');
    localSerena = new SerenaAdapter() as unknown as typeof serena;
    await (localSerena as unknown as { callTool(a: unknown): Promise<unknown> }).callTool({
      tool: 'activate_project',
      arguments: { project: repoPath },
      cwd: repoPath,
    });
  }
  let localLean = leanctx;
  if (!localLean && procedure.steps.some((s) => s.service === 'leanctx')) {
    const { LeanCtxAdapter } = await import('../integrations/leanctx');
    localLean = new LeanCtxAdapter() as unknown as typeof leanctx;
  }

  const results: ExecuteStepResult[] = [];
  const pendingReview: ExecuteStepResult[] = [];

  for (const step of procedure.steps) {
    const write = isWriteStep(step);
    const base: ExecuteStepResult = { service: step.service, tool: step.tool, write, verdict: write ? 'review' : 'auto', executed: false };

    try {
      const args = await fillArgs(step, repoPath);
      let expectedAfter: string | null = null;
      let verifyPath = '';
      if (write) {
        base.verdict = 'review';
        base.approved = Boolean(await approve(step, args));
        if (!base.approved) {
          base.executed = false;
          results.push(base);
          pendingReview.push(base);
          options.onStep?.(base);
          continue;
        }
        // Capture the expected post-apply content from the reviewed diff BEFORE
        // mutating. Best-effort: a diff-computation failure must not block the write.
        try {
          const proposal = buildWriteDiff(step, args, repoPath);
          expectedAfter = proposal.after;
          verifyPath = proposal.path;
        } catch {
          expectedAfter = null;
          verifyPath = '';
        }
      }
      const adapter = step.service === 'serena' ? localSerena : step.service === 'leanctx' ? localLean : undefined;
      if (!adapter) {
        base.error = `no adapter for service '${step.service}'`;
        results.push(base);
        options.onStep?.(base);
        continue;
      }
      const output = await invoke(adapter, step.service, step.tool, args, repoPath);
      base.executed = true;
      base.output = output;
      if (/Error executing tool/.test(output)) {
        base.error = output;
      } else if (write) {
        // Apply-side diff check: does the applied file match what was reviewed?
        const file = join(repoPath, verifyPath);
        if (expectedAfter === null) {
          base.verified = false;
          base.verifyNote = 'verification unsupported';
        } else if (!existsSync(file)) {
          base.verified = false;
          base.verifyNote = 'file missing after apply';
        } else {
          // Normalize line endings (CRLF vs LF) — Serena writes per the
          // project config, which on Windows is CRLF; the reviewed content
          // uses \n. Compare the normalized text.
          const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
          const actual = readFileSync(file, 'utf8');
          base.verified = normalize(actual) === normalize(expectedAfter);
          base.verifyNote = base.verified
            ? 'applied matches reviewed diff'
            : 'applied content differs from reviewed diff';
        }
      }
    } catch (err) {
      base.error = (err as Error).message;
    }
    results.push(base);
    options.onStep?.(base);
  }

  // Close lazily-created adapters.
  if (!serena && localSerena) {
    await (localSerena as unknown as { close?(): Promise<unknown> }).close?.().catch(() => undefined);
  }
  if (!leanctx && localLean) {
    await (localLean as unknown as { close?(): Promise<unknown> }).close?.().catch(() => undefined);
  }

  const allExecuted = pendingReview.length === 0;
  const failed = results.some((r) => r.executed && r.error !== undefined);
  const ok = allExecuted && !failed;

  if (recordOutcome && allExecuted) {
    store.recordOutcome(procedure.id, failed ? 'failure' : 'success');
  }

  return { procedureId: procedure.id, ok, allExecuted, results, pendingReview };
}
