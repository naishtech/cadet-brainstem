/**
 * Real-Ollama smoke test for LLM trace events (dashboard LLM trace).
 *
 * Verifies end-to-end that a live local-LLM steer call emits
 * `llm.trace.start` / `llm.trace.token` / `llm.trace.complete` events AND that
 * those events survive the cross-process JSONL bridge into a separate
 * "dashboard" EventBus (the same path hook steer events take today).
 *
 * Usage:
 *   npm run smoke:llm-trace                 # default sample prompt
 *   npm run smoke:llm-trace -- "your text"  # steer a specific prompt
 *
 * Prereqs: Ollama installed + running (ollama serve) and the configured model
 * pulled (see ~/.cadet-brainstem/config.yaml). Exits non-zero on failure.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { steerWithFallback, isOllamaAvailable } from '../src/steering/index';
import { EventBus, type DashboardEvent } from '../src/dashboard/event-bus';
import { JsonlTailer } from '../src/dashboard/jsonl-tail';
import { getTraceSink } from '../src/dashboard/trace';

const DEFAULT_PROMPT = 'Fix the Blueprint loading so actors appear in the level.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarize(events: DashboardEvent[]): string {
  const starts = events.filter((e) => e.type === 'llm.trace.start').length;
  const tokens = events.filter((e) => e.type === 'llm.trace.token').length;
  const completes = events.filter((e) => e.type === 'llm.trace.complete').length;
  const usage = events.find((e) => e.type === 'llm.trace.complete') as
    | { type: 'llm.trace.complete'; usage?: { inputTokens?: number; outputTokens?: number } }
    | undefined;
  return [
    `  trace.start    : ${starts}`,
    `  trace.token    : ${tokens}`,
    `  trace.complete : ${completes}`,
    `  usage          : ${usage?.usage ? `${usage.usage.inputTokens ?? '?'} in / ${usage.usage.outputTokens ?? '?'} out` : '(none)'}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ') || DEFAULT_PROMPT;

  process.stdout.write('Checking Ollama availability... ');
  if (!(await isOllamaAvailable())) {
    process.stdout.write('unreachable\n');
    console.error(
      [
        '',
        'Ollama is not reachable (expected at http://localhost:11434).',
        '  - Start it:  ollama serve',
        '  - Pull a model:  see ~/.cadet-brainstem/config.yaml',
        '  - Then re-run:  npm run smoke:llm-trace',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('available\n\n');

  const dir = mkdtempSync(join(tmpdir(), 'cadet-llm-trace-'));
  const logPath = join(dir, 'dashboard.log');

  // ── "Hook" process: its own EventBus persists every event to the JSONL. ──
  const producer = new EventBus({
    capacity: 500,
    persistLogs: true,
    persistPath: logPath,
  });
  const produced: DashboardEvent[] = [];
  producer.subscribe((e) => produced.push(e));

  // ── "Dashboard" process: a separate EventBus bridged via the JSONL. ──────
  const dashboard = new EventBus({
    capacity: 500,
    persistLogs: false,
    persistPath: logPath,
  });
  const bridged: DashboardEvent[] = [];
  dashboard.subscribe((e) => bridged.push(e));
  const tailer = new JsonlTailer({ path: logPath, bus: dashboard, intervalMs: 100 });
  tailer.start();

  process.stdout.write(`Steering (trace-enabled): ${prompt}\n`);
  const started = Date.now();
  const { steering, degraded } = await steerWithFallback(prompt, {
    trace: getTraceSink(producer),
  });
  const elapsedMs = Date.now() - started;
  await producer.flush?.();
  await sleep(500); // let the dashboard poll the JSONL

  console.log(`  steer took ${elapsedMs}ms${degraded ? ' (degraded)' : ''}`);
  console.log(`  task: ${steering.task ?? '(none)'}`);
  console.log('\nProducer (hook) LLM trace events:');
  console.log(summarize(produced));
  console.log('\nDashboard (bridged) LLM trace events:');
  console.log(summarize(bridged));

  tailer.stop();
  rmSync(dir, { recursive: true, force: true });

  // ── Assertions ───────────────────────────────────────────────────────────
  const producerTokens = produced.filter((e) => e.type === 'llm.trace.token').length;
  const bridgeTokens = bridged.filter((e) => e.type === 'llm.trace.token').length;
  const bridgeComplete = bridged.some((e) => e.type === 'llm.trace.complete');

  let ok = true;
  if (producerTokens === 0) {
    console.error('\nFAIL: no llm.trace.token events were emitted by the LLM steer.');
    ok = false;
  }
  if (!bridged.some((e) => e.type === 'llm.trace.start')) {
    console.error('\nFAIL: llm.trace.start did not reach the dashboard via the JSONL bridge.');
    ok = false;
  }
  if (bridgeTokens === 0) {
    console.error('\nFAIL: llm.trace.token events did not reach the dashboard via the JSONL bridge.');
    ok = false;
  }
  if (!bridgeComplete) {
    console.error('\nFAIL: llm.trace.complete did not reach the dashboard via the JSONL bridge.');
    ok = false;
  }

  if (ok) {
    console.log(
      `\nPASS: ${producerTokens} trace tokens produced, ${bridgeTokens} bridged to the dashboard ` +
        '(start + complete present).',
    );
  } else {
    process.exitCode = 1;
  }
}

main();
