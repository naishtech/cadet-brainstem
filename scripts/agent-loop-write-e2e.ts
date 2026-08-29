/**
 * Agent-loop write E2E (task 49, gap #3): drive the REAL components in the
 * exact order the Copilot Chat agent would, for a write procedure:
 *
 *   1. classify  -> matched procedures + procedures_review (write flagged)
 *   2. procedure_apply WITHOUT approved -> refused (review gate)
 *   3. hook-procedure-review -> denies and surfaces the concrete diff
 *   4. procedure_apply WITH approved:true + concrete args -> applies + verifies
 *
 * Uses a scratch repo dir (never the working repo). Requires Ollama (warm).
 *
 * Usage: npx tsx scripts/agent-loop-write-e2e.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleToolCall } from '../src/mcp';
import { runHookProcedureReview } from '../src/cli/commands/hook-procedure-review';
import { ProcedureStore } from '../src/procedure';

const TASK = 'replace content in a file';

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-loop-'));
  const out: string[] = [];
  try {
    writeFileSync(join(scratch, 'a.ts'), 'const x = 1;\n', 'utf8');

    // 1. classify -> matched procedures + review flags.
    const classify = JSON.parse(
      (await handleToolCall('classify', { task: TASK })).content[0]!.text,
    );
    const procs: Array<{ id: string; triggerPattern: string; riskTier: string }> =
      classify.procedures ?? [];
    const reviews: Array<{ triggerPattern: string }> = classify.procedures_review ?? [];
    const target = procs.find((p) => p.triggerPattern === 'Replace content in a file');
    console.log('1. classify -> matched:', procs.length, '| write-flagged:', reviews.length);
    if (!target) {
      console.log('   (no "Replace content in a file" procedure matched — aborting)');
      return;
    }
    console.log('   using procedure:', target.id, '| risk:', target.riskTier);

    const concrete = {
      replace_content: { relative_path: 'a.ts', needle: 'x', repl: 'y', mode: 'literal' },
    };

    // 2. procedure_apply WITHOUT approved -> must refuse (review gate).
    const refused = JSON.parse(
      (await handleToolCall('procedure_apply', {
        procedure_id: target.id,
        repo: scratch,
        approved: false,
      })).content[0]!.text,
    );
    console.log('2. procedure_apply (no approval) -> refused:', refused.ok === false);

    // 3. hook-procedure-review -> deny + concrete diff.
    await runHookProcedureReview({
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: scratch,
          tool_name: 'procedure_apply',
          tool_input: { procedure_id: target.id, repo: scratch, args: concrete },
        }),
      writeOut: (line) => out.push(line),
      store: new ProcedureStore(),
    });
    const hook = JSON.parse(out[0]!);
    const ctx = hook.hookSpecificOutput.additionalContext as string;
    const denied = hook.hookSpecificOutput.permissionDecision === 'deny';
    const hasDiff = ctx.includes('-const x = 1;') && ctx.includes('+const y = 1;');
    console.log('3. hook-procedure-review -> denied:', denied, '| surfaced diff:', hasDiff);

    // 4. procedure_apply WITH approved:true + concrete args -> apply + verify.
    const applied = JSON.parse(
      (await handleToolCall('procedure_apply', {
        procedure_id: target.id,
        repo: scratch,
        approved: true,
        args: concrete,
      })).content[0]!.text,
    );
    const step = applied.results?.[0];
    const finalContent = readFileSync(join(scratch, 'a.ts'), 'utf8');
    const appliedOk = applied.ok === true && step?.verified === true;
    console.log('4. procedure_apply (approved) -> ok:', applied.ok === true);
    console.log('   verified:', step?.verified, '|', step?.verifyNote);
    console.log('   final content:', JSON.stringify(finalContent));

    console.log('');
    console.log(
      appliedOk && denied && hasDiff && refused.ok === false
        ? 'AGENT-LOOP WRITE E2E: PASS'
        : 'AGENT-LOOP WRITE E2E: FAIL',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

void main();
