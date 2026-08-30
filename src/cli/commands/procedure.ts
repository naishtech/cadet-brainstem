/**
 * `cadet-brainstem procedure` — list procedures and run one against a real repo
 * through the live execution bridge + review gate (task 49).
 *
 * Usage:
 *   cadet-brainstem procedure list
 *   cadet-brainstem procedure run <id> --repo <path> [--yes]
 *
 * `run` executes the procedure's steps against the real repo. Write steps are
 * gated behind a y/n review prompt (unless `--yes` auto-approves them).
 */
import { createInterface } from 'node:readline';
import {
  buildWriteDiff,
  defaultFillArgs,
  executeProcedure,
  getDefaultProcedurePath,
  isWriteStep,
  ProcedureStore,
} from '../../procedure';
import type { CliCommand } from '../types';

function openStore(): ProcedureStore {
  return new ProcedureStore(process.env.CADET_BRAINSTEM_PROCEDURES ?? getDefaultProcedurePath());
}

function listProcedures(): number {
  const store = openStore();
  const procedures = store.list();
  if (procedures.length === 0) {
    console.log('No procedures. Seed with: npm run seed:procedures');
    store.close();
    return 0;
  }
  for (const p of procedures) {
    console.log(`${p.id}  [${p.riskTier}]  ${p.triggerPattern}`);
    console.log(`    steps: ${p.steps.map((s) => `${s.service}:${s.tool}`).join(' -> ')}`);
    console.log(`    record: ${p.successCount} ok / ${p.failureCount} fail`);
  }
  store.close();
  return 0;
}

/** Prompt the user for y/n. Returns true on 'y'/'yes'. */
function promptApprove(label: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${label} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function reviewProcedure(id: string, repo: string): Promise<number> {
  const store = openStore();
  const procedure = store.get(id);
  if (procedure === null) {
    console.error(`No procedure with id "${id}".`);
    store.close();
    return 1;
  }
  const writeSteps = procedure.steps.filter((s) => isWriteStep(s));
  console.log(`Procedure: ${procedure.triggerPattern} [${procedure.riskTier}]`);
  console.log(`Repo:      ${repo}`);
  if (writeSteps.length === 0) {
    console.log('No write steps — nothing to review.');
    store.close();
    return 0;
  }
  console.log(`Write steps to review: ${writeSteps.length}\n`);
  let ok = true;
  for (const step of writeSteps) {
    console.log(`===== ${step.service}:${step.tool} =====`);
    try {
      const args = await defaultFillArgs(step, repo);
      console.log(`args: ${JSON.stringify(args)}`);
      const proposal = buildWriteDiff(step, args, repo);
      if (proposal.unsupported) {
        console.log('(no diff available for this tool — review the args above)');
      } else {
        console.log(`path: ${proposal.path}  kind: ${proposal.kind}`);
        console.log('--- diff ---');
        console.log(proposal.diff);
      }
    } catch (err) {
      ok = false;
      console.log(`failed to build diff: ${(err as Error).message}`);
    }
    console.log('');
  }
  store.close();
  return ok ? 0 : 1;
}

async function runProcedure(id: string, repo: string, yes: boolean): Promise<number> {
  const store = openStore();
  const procedure = store.get(id);
  if (procedure === null) {
    console.error(`No procedure with id "${id}".`);
    store.close();
    return 1;
  }
  console.log(`Procedure: ${procedure.triggerPattern} [${procedure.riskTier}]`);
  console.log(`Repo:      ${repo}`);
  console.log(`Steps:     ${procedure.steps.map((s) => `${s.service}:${s.tool}`).join(' -> ')}`);

  const result = await executeProcedure(procedure, {
    repoPath: repo,
    store,
    approve: async (step, args) => {
      if (yes) {
        console.log(`  [auto-approve] ${step.service}:${step.tool} ${JSON.stringify(args)}`);
        return true;
      }
      return promptApprove(`  approve ${step.service}:${step.tool} ${JSON.stringify(args)}?`);
    },
    onStep: (r) => {
      const status = r.executed ? 'OK' : r.approved === false ? 'SKIPPED (review)' : r.error ? 'ERROR' : 'PENDING';
      console.log(`  ${status.padEnd(16)} ${r.service}:${r.tool}${r.output ? ` — ${r.output.slice(0, 80)}` : ''}${r.error ? ` — ${r.error.slice(0, 80)}` : ''}`);
    },
  });

  console.log('');
  if (result.pendingReview.length > 0) {
    console.log(`Blocked: ${result.pendingReview.length} write step(s) pending review.`);
  }
  console.log(`Outcome: ${result.allExecuted ? (result.ok ? 'success' : 'failure') : 'not run (review blocked)'}`);
  store.close();
  return result.ok ? 0 : 1;
}

export const procedureCommand: CliCommand = {
  name: 'procedure',
  description:
    'List procedures and run/review one against a real repo via the execution bridge (list|run|review)',
  usage:
    'cadet-brainstem procedure <list|run <id> --repo <path> [--yes]|review <id> --repo <path>>',
  run(args: readonly string[]): Promise<number> | number {
    const sub = args[0];
    if (sub === 'list') {
      return listProcedures();
    }
    if (sub === 'run' || sub === 'review') {
      const rest = args.slice(1);
      let id: string | undefined;
      let repo: string | undefined;
      let yes = false;
      for (let i = 0; i < rest.length; i += 1) {
        const next = rest[i + 1];
        const current = rest[i];
        if (current === '--repo' && next !== undefined) repo = next;
        else if (current === '--yes') yes = true;
        else if (id === undefined && current !== undefined && !current.startsWith('--')) id = current;
      }
      if (id === undefined || repo === undefined) {
        console.error(`Usage: cadet-brainstem procedure ${sub} <id> --repo <path>${sub === 'run' ? ' [--yes]' : ''}`);
        return 1;
      }
      if (sub === 'review') {
        return reviewProcedure(id, repo);
      }
      return runProcedure(id, repo, yes);
    }
    console.error('Usage: cadet-brainstem procedure <list|run <id> --repo <path> [--yes]|review <id> --repo <path>>');
    return 1;
  },
};
