/**
 * `hook-procedure-review` — PreToolUse hook for the agent loop (task 49).
 *
 * When the agent calls `procedure_apply` WITHOUT explicit approval, this hook
 * DENIES and returns the concrete reviewable diff(s) for the write steps, so
 * the change is surfaced to the user before anything is applied. When the call
 * already carries `approved: true` (user confirmed), it ALLOWS.
 *
 * Safe no-op (allow) for every other tool.
 *
 * Usage (VS Code hooks):
 *   cadet-brainstem hook-procedure-review   # reads the PreToolUse payload on stdin
 */
import {
  buildWriteDiff,
  defaultFillArgs,
  isWriteStep,
  ProcedureStore,
} from '../../procedure';
import { getActiveProcedure, readPayload, type HookPayload, type HookLifecycleDeps } from './hook-lifecycle';
import type { CliCommand } from '../types';

export interface ProcedureReviewHookDeps {
  readStdin?: () => Promise<string>;
  writeOut?: (line: string) => void;
  /** Injectable procedure store (tests). */
  store?: ProcedureStore;
  stateDir?: string;
}

const DIRECT_WRITE_TOOLS = new Set([
  'create_file',
  'create_text_file',
  'replace_string_in_file',
  'apply_patch',
  'edit_file',
  'replace_content',
  'insert_after_symbol',
  'insert_before_symbol',
  'rename_symbol',
  'safe_delete_symbol',
  'write_file',
]);

/** Build the reviewable diff text for a procedure's write steps (best-effort). */
export async function buildReviewText(
  procedureId: string,
  repo: string,
  input: Record<string, unknown>,
  store: ProcedureStore,
): Promise<{ text: string; exists: boolean }> {
  const procedure = store.get(procedureId);
  if (procedure === null) {
    return { text: `No procedure with id "${procedureId}".`, exists: false };
  }
  const perToolArgs = (input['args'] ?? {}) as Record<string, Record<string, unknown>>;
  const lines: string[] = [
    `User approval required before applying procedure "${procedure.triggerPattern}" (${procedureId}).`,
    '',
  ];
  for (const step of procedure.steps.filter((s) => isWriteStep(s))) {
    lines.push(`===== ${step.service}:${step.tool} =====`);
    try {
      const args = perToolArgs[step.tool] ?? (await defaultFillArgs(step, repo));
      lines.push(`args: ${JSON.stringify(args)}`);
      const proposal = buildWriteDiff(step, args, repo);
      if (proposal.unsupported) {
        lines.push('(no diff available for this tool — review the args above)');
      } else {
        lines.push(`path: ${proposal.path}  kind: ${proposal.kind}`);
        lines.push(proposal.diff);
      }
    } catch (err) {
      lines.push(`(diff error: ${(err as Error).message})`);
    }
    lines.push('');
  }
  lines.push(
    'Review the change above. To apply, re-invoke procedure_apply with approved:true after the user confirms.',
  );
  return { text: lines.join('\n'), exists: true };
}

/**
 * Handle a single PreToolUse hook invocation. Denies procedure_apply without
 * `approved:true` (surfacing the diff); allows with approval and for all other
 * tools. Emits nothing on an empty/invalid payload (safe no-op).
 */
export async function runHookProcedureReview(
  deps: ProcedureReviewHookDeps = {},
): Promise<number> {
  const payload: HookPayload | null = await readPayload(deps as never);
  if (payload === null) {
    return 0;
  }
  const w = deps.writeOut ?? ((line: string) => process.stdout.write(line));
  const emit = (permissionDecision: string, additionalContext?: string): void => {
    w(
      JSON.stringify({
        hookSpecificOutput: {
          permissionDecision,
          ...(additionalContext !== undefined ? { additionalContext } : {}),
        },
      }),
    );
  };

  const toolName = String(payload.tool_name ?? payload.toolName ?? '').toLowerCase();
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';
  const active = getActiveProcedure(sessionId, { stateDir: deps.stateDir } as HookLifecycleDeps);
  const hookRepo = payload.cwd ?? process.cwd();
  if (active !== undefined && active.repo === hookRepo && toolName !== 'procedure_review' && toolName !== 'procedure_apply') {
    const baseName = toolName.split('.').pop() ?? toolName;
    const input = (payload.tool_input ?? payload.toolInput ?? {}) as Record<string, unknown>;
    const command = String(input.command ?? input.cmd ?? '').trim().toLowerCase();
    const directWrite = DIRECT_WRITE_TOOLS.has(baseName) ||
      (['run_in_terminal', 'bash', 'powershell', 'shell', 'cmd'].some((name) => baseName.includes(name)) &&
        /(^|\s)(>>?|del|erase|rm|remove-item|set-content|add-content|copy|move|mv|cp)(\s|$)/.test(command));
    if (directWrite) {
      emit(
        'deny',
        `A review-required procedure is active: "${active.triggerPattern}" (${active.procedureId}). ` +
          'Do not write directly. Call procedure_review first, wait for user approval, then call procedure_apply.',
      );
      return 0;
    }
  }
  if (toolName !== 'procedure_apply') {
    emit('allow');
    return 0;
  }

  const input = (payload.tool_input ?? payload.toolInput ?? {}) as Record<string, unknown>;
  const approved = input['approved'] === true;
  if (approved) {
    emit('allow');
    return 0;
  }

  const procedureId = String(input['procedure_id'] ?? '');
  const repo = String(input['repo'] ?? payload.cwd ?? process.cwd());
  if (!procedureId) {
    emit('deny', 'procedure_apply requires procedure_id; nothing was applied.');
    return 0;
  }

  const store = deps.store ?? new ProcedureStore();
  try {
    const { text, exists } = await buildReviewText(procedureId, repo, input, store);
    emit('deny', exists ? text : `${text} Nothing was applied.`);
  } finally {
    if (deps.store === undefined) {
      store.close();
    }
  }
  return 0;
}

export const hookProcedureReviewCommand: CliCommand = {
  name: 'hook-procedure-review',
  description:
    'PreToolUse hook: deny procedure_apply without approval and surface the reviewable diff (allow with approved:true / for other tools)',
  usage: 'cadet-brainstem hook-procedure-review',
  run(): Promise<number> {
    return runHookProcedureReview();
  },
};
