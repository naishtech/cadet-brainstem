import { getDefaultMetricsPath, MetricsStore } from '../../metrics';
import type { CliCommand } from '../types';
import { askYesNo } from './init';

export interface StatsDeps {
  /** Override the metrics db path (tests). */
  metricsPath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
  /** Confirmation prompt (tests). Defaults to askYesNo. */
  ask?: (question: string) => Promise<boolean>;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Terminal summary of saved/processed metrics (design doc §8, Task 17).
 *
 * All figures are ESTIMATES where not directly measured — the output labels
 * them as such. Works fully offline. Exits non-zero only if the metrics
 * database cannot be opened.
 */
export async function runStats(deps: StatsDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();

  let store: MetricsStore;
  try {
    store = new MetricsStore(metricsPath);
  } catch (err) {
    log(
      `[cadet-token-saver] stats: could not open metrics database at ${metricsPath}`,
    );
    log(`  ${(err as Error).message}`);
    log('  Run "cadet-token-saver init" to create it.');
    return 1;
  }

  try {
    const count = store.count();
    log('');
    log('Cadet Token Saver Stats');
    log('-----------------------');
    log(`Metrics database: ${metricsPath}`);

    if (count === 0) {
      log('');
      log('No optimisation events recorded yet.');
      log(
        'Use the MCP `optimize_context` / `compress_command_output` tools (or `wrap`) to start tracking savings.',
      );
      return 0;
    }

    const totals = store.getTotals();
    const byTool = store.getSavingsByTool();
    const byTask = store.getSavingsByTaskType();
    const sessions = store.getSessionSummary();
    const avgCompression = store.getAverageCompressionRatio();
    const expensive = store.getMostExpensiveOperations(5);
    const callStats = store.getCallStatsByTool();

    const reductionPct =
      totals.estimatedInputTokens > 0
        ? Math.round((totals.estimatedTokensSaved / totals.estimatedInputTokens) * 100)
        : 0;

    log('');
    log(`Events:            ${formatTokens(totals.eventCount)}`);
    log(`Input tokens:      ${formatTokens(totals.estimatedInputTokens)}   (estimate)`);
    log(`Output tokens:     ${formatTokens(totals.estimatedOutputTokens)}   (estimate)`);
    log(`Tokens saved:      ${formatTokens(totals.estimatedTokensSaved)}   (estimate)`);
    log(`Reduction:         ${reductionPct}%   (estimate)`);
    log(
      `Avg compression:   ${
        avgCompression !== null ? avgCompression.toFixed(2) : 'n/a'
      }   (estimate)`,
    );

    log('');
    log('Savings by tool:');
    for (const row of byTool) {
      log(
        `  ${row.key.padEnd(12)} ${formatTokens(row.estimatedTokensSaved)} tokens`,
      );
    }

    log('');
    log('Savings by task type:');
    for (const row of byTask) {
      log(
        `  ${row.key.padEnd(12)} ${formatTokens(row.estimatedTokensSaved)} tokens`,
      );
    }

    log('');
    log('Local tool calls:');
    const callStatMap = new Map(callStats.map((c) => [c.tool, c]));
    for (const tool of ['ollama', 'rtk', 'serena', 'leanctx', 'memory']) {
      const stat = callStatMap.get(tool);
      const calls = stat?.calls ?? 0;
      const degraded = stat?.degraded ?? 0;
      const avgMs = stat?.avgLatencyMs;
      const degradedNote = degraded > 0 ? ` · ${degraded} degraded` : '';
      const latencyNote =
        avgMs !== null && avgMs !== undefined ? ` · avg ${formatTokens(avgMs)}ms` : '';
      log(`  ${tool.padEnd(12)} ${calls} call(s)${degradedNote}${latencyNote}`);
    }

    log('');
    log('Sessions:');
    for (const session of sessions) {
      log(
        `  ${session.session_id.padEnd(24)} ${session.eventCount} event(s) · ${formatTokens(
          session.estimatedTokensSaved,
        )} tokens saved`,
      );
    }

    log('');
    log('Most expensive operations:');
    for (const op of expensive) {
      log(
        `  #${String(op.id).padStart(3)}  ${op.tool.padEnd(8)} ${op.operation.padEnd(22)} ${formatTokens(
          op.estimatedInputTokens,
        )} in · ${formatTokens(op.estimatedTokensSaved)} saved`,
      );
    }

    log('');
    log(
      'All figures are ESTIMATES — see https://github.com/naishtech/cadet-token-saver/blob/main/docs/plans/initial_design.md#8-measurement-and-metrics',
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `stats clear` — empty the metrics database after an explicit confirmation.
 * Non-interactive (or declined) runs clear nothing. Truncates rows only; the
 * database file and table remain intact.
 */
export async function runStatsClear(deps: StatsDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = deps.ask ?? askYesNo;
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();

  let store: MetricsStore;
  try {
    store = new MetricsStore(metricsPath);
  } catch (err) {
    log(
      `[cadet-token-saver] stats clear: could not open metrics database at ${metricsPath}`,
    );
    log(`  ${(err as Error).message}`);
    return 1;
  }

  try {
    const count = store.count();
    log('');
    log(`Metrics database: ${metricsPath}`);
    log(`Will clear ${count} recorded event(s).`);
    const confirmed = await ask('Clear ALL metrics? This cannot be undone. [y/N]');
    if (!confirmed) {
      log('Aborted — no data was cleared.');
      return 0;
    }
    const removed = store.clear();
    log(`Cleared ${removed} event(s).`);
    return 0;
  } finally {
    store.close();
  }
}

export const statsCommand: CliCommand = {
  name: 'stats',
  description: 'Show saved/processed token metrics (clear to wipe them)',
  usage: 'cadet-token-saver stats [clear]',
  run(args: readonly string[]): Promise<number> {
    if (args[0] === 'clear') {
      return runStatsClear();
    }
    return runStats();
  },
};
