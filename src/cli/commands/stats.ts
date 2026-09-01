import { formatStats, getDefaultMetricsPath, MetricsStore } from '../../metrics';
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
      `[cadet-brainstem] stats: could not open metrics database at ${metricsPath}`,
    );
    log(`  ${(err as Error).message}`);
    log('  Run "cadet-brainstem init" to create it.');
    return 1;
  }

  try {
    const payload = formatStats(store);
    log('');
    log('Cadet Brainstem Stats');
    log('-----------------------');
    log(`Metrics database: ${metricsPath}`);

    if (payload.count === 0) {
      log('');
      log('No optimisation events recorded yet.');
      log(
        'Use the MCP `optimize_context` tool to start tracking savings.',
      );
      return 0;
    }

    const totals = payload.totals;
    const byTool = payload.savingsByTool;
    const byTask = payload.savingsByTaskType;
    const sessions = payload.sessions;
    const avgCompression = totals.avgCompressionRatio;
    const expensive = payload.mostExpensiveOperations;
    const callStats = payload.callStats;
    const reductionPct = totals.reductionPct;

    log('');
    log(`Events:            ${formatTokens(totals.eventCount)}`);
    log(`Input tokens:      ${formatTokens(totals.inputTokens)}   (estimate)`);
    log(`Output tokens:     ${formatTokens(totals.outputTokens)}   (estimate)`);
    log(`Tokens saved:      ${formatTokens(totals.tokensSaved)}   (estimate)`);
    log(`Reduction:         ${reductionPct}%   (estimate)`);
    log(
      `Avg compression:   ${
        avgCompression !== null ? avgCompression.toFixed(2) : 'n/a'
      }   (estimate)`,
    );

    log('');
    log('Savings by tool:');
    if (byTool.length === 0) {
      log(
        '  (none recorded yet — use optimize_context to start saving tokens)',
      );
    } else {
      for (const row of byTool) {
        log(
          `  ${row.key.padEnd(12)} ${formatTokens(row.estimatedTokensSaved)} tokens`,
        );
      }
    }

    log('');
    log('Savings by task type:');
    if (byTask.length === 0) {
      log('  (none recorded yet)');
    } else {
      for (const row of byTask) {
        log(
          `  ${row.key.padEnd(12)} ${formatTokens(row.estimatedTokensSaved)} tokens`,
        );
      }
    }

    log('');
    log('Local tool calls:');
    const callStatMap = new Map(callStats.map((c) => [c.tool, c]));
    for (const tool of ['ollama', 'serena', 'leanctx', 'memory']) {
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
    log('Steer calls by origin:');
    const steerByOrigin = payload.steerByOrigin;
    if (steerByOrigin.length === 0) {
      log('  (none yet — steer is not being invoked via hook or MCP)');
    } else {
      for (const row of steerByOrigin) {
        const degradedNote = row.degraded > 0 ? ` · ${row.degraded} degraded` : '';
        log(
          `  ${row.origin.padEnd(8)} ${row.calls} call(s)${degradedNote}`,
        );
      }
    }

    log('');
    log('Recommended vs invoked (adoption):');
    const recommended = payload.recommendedByTool;
    const recMap = new Map(recommended.map((r) => [r.tool, r.calls]));
    const toolSet = new Set<string>([...recMap.keys(), ...callStatMap.keys()]);
    if (toolSet.size === 0) {
      log('  (none yet — call steer to record recommendations)');
    } else {
      for (const tool of [...toolSet].sort()) {
        const rec = recMap.get(tool) ?? 0;
        const invoked = callStatMap.get(tool)?.calls ?? 0;
        log(
          `  ${tool.padEnd(12)} recommended ${rec} · invoked ${invoked}`,
        );
      }
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
      'All figures are ESTIMATES — see https://github.com/naishtech/cadet-brainstem/blob/main/docs/plans/initial_design.md#8-measurement-and-metrics',
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
      `[cadet-brainstem] stats clear: could not open metrics database at ${metricsPath}`,
    );
    log(`  ${(err as Error).message}`);
    return 1;
  }

  try {
    const count = store.count();
    log('');
    log(`Metrics database: ${metricsPath}`);
    log(`Will clear ${count} recorded event(s).`);
    const confirmed = await ask('Clear ALL metrics? This cannot be undone.');
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
  usage: 'cadet-brainstem stats [clear]',
  run(args: readonly string[]): Promise<number> {
    if (args[0] === 'clear') {
      return runStatsClear();
    }
    return runStats();
  },
};
