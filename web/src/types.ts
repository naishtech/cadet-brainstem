export type ServiceKind = 'llm' | 'serena' | 'leanctx';

export interface ToolStatus {
  name: string;
  available: boolean;
  detail?: string;
  kind: ServiceKind;
}

export interface StatsPayload {
  count: number;
  estimated: boolean;
  totals: {
    eventCount: number;
    inputTokens: number;
    outputTokens: number;
    tokensSaved: number;
    reductionPct: number;
    avgCompressionRatio: number | null;
  };
  savingsByTool: Array<{ key: string; estimatedTokensSaved: number }>;
  savingsByTaskType: Array<{ key: string; estimatedTokensSaved: number }>;
  callStats: Array<{ tool: string; calls: number; degraded: number; avgLatencyMs: number | null }>;
  steerByOrigin: Array<{ origin: string; calls: number; degraded: number }>;
  recommendedByTool: Array<{ tool: string; calls: number }>;
  sessions: Array<{ session_id: string; eventCount: number; estimatedTokensSaved: number }>;
  mostExpensiveOperations: Array<{
    id: number;
    tool: string;
    operation: string;
    estimatedInputTokens: number;
    estimatedTokensSaved: number;
    timestamp: string;
  }>;
}

export type EventCategory = 'steering' | 'procedures' | 'system';

export type DashboardEvent =
  | { type: 'log'; level: string; ts: number; source: string; message: string }
  | { type: 'request'; ts: number; id: string; tool: string; operation: string; inputHint?: string }
  | { type: 'response'; ts: number; id: string; ok: boolean; latencyMs?: number; outputHint?: string }
  | { type: 'status'; ts: number; services: ToolStatus[] }
  | { type: 'llm.trace.start'; ts: number; id: string; model: string; request: string }
  | { type: 'llm.trace.token'; ts: number; id: string; delta: string }
  | {
      type: 'llm.trace.complete';
      ts: number;
      id: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'llm.trace.think.start'; ts: number; id: string }
  | { type: 'llm.trace.think.token'; ts: number; id: string; delta: string }
  | { type: 'llm.trace.think.complete'; ts: number; id: string }
  | { type: 'stats.updated'; ts: number };
