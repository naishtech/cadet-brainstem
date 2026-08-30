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
import { readPayload, type HookPayload } from './hook-lifecycle';
import type { CliCommand } from '../types';

export interface ProcedureReviewHookDeps {
  readStdin?: () => Promise<string>;
  writeOut?: (line: string) => void;
  /** Injectable procedure store (tests). */
  store?: ProcedureStore;
}

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
