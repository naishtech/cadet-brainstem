/**
 * Seed the `procedures` table with initial, READ-ONLY procedures (task 44,
 * revised design).
 *
 * The local LLM executes these on behalf of the cloud LLM. Every step maps to a
 * real local service the local LLM has: LeanCTX (`leanctx`), Serena
 * (`serena`), RTK (`rtk`). All are read-only / context-reduction — no shell
 * write actions, no git commit/PR. All seed tiers are `auto_execute`.
 *
 * Usage:
 *   npm run seed:procedures            # seed only if the table is empty
 *   npm run seed:procedures -- --force # clear and re-seed
 */
import { ProcedureStore, getDefaultProcedurePath, type SeedProcedureInput } from '../src/procedure/index';

const SEED: SeedProcedureInput[] = [
  {
    triggerPattern: 'Gather and compress relevant context',
    keywords: ['context', 'read', 'compress', 'file', 'ctx'],
    steps: [{ service: 'leanctx', tool: 'ctx_read', args: { mode: 'map' } }],
    riskTier: 'auto_execute', // read-only, local
  },
  {
    triggerPattern: 'Find symbols for a change',
    keywords: ['symbol', 'find', 'reference', 'rename', 'serena'],
    steps: [{ service: 'serena', tool: 'find_symbol', args: {} }],
    riskTier: 'auto_execute', // read-only, local
  },
  {
    triggerPattern: 'Compress a command output',
    keywords: ['compress', 'command', 'output', 'rtk', 'shell'],
    steps: [{ service: 'rtk', tool: 'compress_command_output', args: {} }],
    riskTier: 'auto_execute', // read-only, local
  },
  {
    triggerPattern: 'Summarize project structure',
    keywords: ['structure', 'explore', 'tree', 'layout', 'project'],
    steps: [{ service: 'leanctx', tool: 'ctx_explore', args: {} }],
    riskTier: 'auto_execute', // read-only, local
  },
];

function main(): void {
  const force = process.argv.includes('--force');
  const store = new ProcedureStore();
  const dbPath = getDefaultProcedurePath();

  if (store.count() > 0 && !force) {
    console.error(`procedures table already has ${store.count()} rows at ${dbPath}`);
    console.error('Pass --force to clear and re-seed.');
    process.exitCode = 0;
    store.close();
    return;
  }
  if (force) {
    const removed = store.clear();
    console.log(`cleared ${removed} existing procedures`);
  }

  for (const procedure of SEED) {
    const id = store.seedProcedure(procedure);
    console.log(`seeded ${procedure.riskTier.padEnd(16)} ${procedure.triggerPattern} -> ${id}`);
  }

  console.log(`\n${store.count()} procedures in ${dbPath}`);
  store.close();
}

main();
