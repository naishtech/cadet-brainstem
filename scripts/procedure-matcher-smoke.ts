/**
 * Real-Ollama + real-DB smoke test for the procedure matcher (task 44).
 *
 * Runs the full `classifyTool` path against the live seeded `procedures` table
 * and the real local Ollama classifier — no injected stubs. Verifies the cloud
 * LLM would receive a `procedures` handoff list.
 *
 * Usage:
 *   npm run smoke:procedures
 *
 * Prereqs: Ollama installed + running (`ollama serve`), a model pulled, and
 * the procedures table seeded (`npm run seed:procedures`).
 */
import { classifyTool } from '../src/mcp/server';
import { ProcedureStore } from '../src/procedure';
import { isOllamaAvailable } from '../src/classifier';

const SAMPLES = [
  'gather and compress the relevant context for this file',
  'find the symbols that reference the loader',
];

async function main(): Promise<void> {
  process.stdout.write('Checking Ollama availability... ');
  if (!(await isOllamaAvailable())) {
    process.stdout.write('unreachable\n');
    console.error(
      [
        '',
        'Ollama is not reachable (expected at http://localhost:11434).',
        '  - Start it:  ollama serve',
        '  - Then re-run:  npm run smoke:procedures',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('available\n');

  const store = new ProcedureStore();
  console.log(`\nSeeded procedures in live DB: ${store.count()}`);
  store.close();

  for (const task of SAMPLES) {
    process.stdout.write(`\n--- classify: "${task}" ---\n`);
    try {
      const result = await classifyTool({ task });
      console.log(`entities:      ${JSON.stringify(result.entities)}`);
      const procedures = (result.procedures ?? []) as Array<{ triggerPattern: string; steps: unknown[] }>;
      console.log(`matched procedures: ${procedures.length}`);
      for (const p of procedures) {
        console.log(`  - ${p.triggerPattern}  steps=${JSON.stringify(p.steps)}`);
      }
      console.log(`degraded:      ${result.degraded === true}`);
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
    }
  }
}

void main();
