import { getDefaultMetricsPath, MetricsStore } from '../../metrics';
import type { CliCommand } from '../types';

export interface StatsDeps {
  /** Override the metrics db path (tests). */
  metricsPath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
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
    log('All figures are ESTIMATES — see docs/plans/initial_design.md §8.');
    return 0;
  } finally {
    store.close();
  }
}

export const statsCommand: CliCommand = {
  name: 'stats',
  description: 'Show saved/processed token metrics',
  usage: 'cadet-token-saver stats',
  run(): Promise<number> {
    return runStats();
  },
};
