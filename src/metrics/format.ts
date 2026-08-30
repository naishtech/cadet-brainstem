import type {
  CallStats,
  GroupedCalls,
  GroupedSavings,
  MostExpensiveOperation,
  SessionSummary,
} from './store';
import type { MetricsStore } from './store';

/**
 * Structured, JSON-safe payload of everything the `stats` command renders
 * (design doc §5.6). The CLI and the dashboard `/api/stats` both consume this
 * so they can never drift. All token figures are estimates, flagged `estimated:
 * true` so the UI can show an ESTIMATES note.
 */
export interface StatsPayload {
  count: number;
  /** Every token figure in this payload is an estimate. */
  estimated: true;
  totals: {
    eventCount: number;
    inputTokens: number;
    outputTokens: number;
    tokensSaved: number;
    reductionPct: number;
    avgCompressionRatio: number | null;
  };
  savingsByTool: GroupedSavings[];
  savingsByTaskType: GroupedSavings[];
  callStats: CallStats[];
  classifyByOrigin: Array<{ origin: string; calls: number; degraded: number }>;
  recommendedByTool: GroupedCalls[];
  sessions: SessionSummary[];
  mostExpensiveOperations: MostExpensiveOperation[];
}

/**
 * Single source of truth for stats — shared by the CLI (`runStats`) and the
 * dashboard `/api/stats` endpoint so both render identical numbers.
 */
export function formatStats(store: MetricsStore): StatsPayload {
  const totals = store.getTotals();
  const avgCompression = store.getAverageCompressionRatio();
  const reductionPct =
    totals.estimatedInputTokens > 0
      ? Math.round((totals.estimatedTokensSaved / totals.estimatedInputTokens) * 100)
      : 0;

  return {
    count: store.count(),
    estimated: true,
    totals: {
      eventCount: totals.eventCount,
      inputTokens: totals.estimatedInputTokens,
      outputTokens: totals.estimatedOutputTokens,
      tokensSaved: totals.estimatedTokensSaved,
      reductionPct,
      avgCompressionRatio: avgCompression,
    },
    savingsByTool: store.getSavingsByTool(),
    savingsByTaskType: store.getSavingsByTaskType(),
    callStats: store.getCallStatsByTool(),
    classifyByOrigin: store.getClassifyCallsByOrigin(),
    recommendedByTool: store.getRecommendedByTool(),
    sessions: store.getSessionSummary(),
    mostExpensiveOperations: store.getMostExpensiveOperations(5),
  };
}
