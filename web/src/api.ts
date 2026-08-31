import type { DashboardEvent, StatsPayload, ToolStatus } from './types';

export async function getStats(): Promise<StatsPayload> {
  const res = await fetch('/api/stats');
  if (!res.ok) throw new Error(`stats request failed: ${res.status}`);
  return (await res.json()) as StatsPayload;
}

export async function getStatus(): Promise<ToolStatus[]> {
  const res = await fetch('/api/status');
  if (!res.ok) throw new Error(`status request failed: ${res.status}`);
  return (await res.json()) as ToolStatus[];
}

export async function getLogs(limit = 100): Promise<DashboardEvent[]> {
  const res = await fetch(`/api/logs?limit=${limit}`);
  if (!res.ok) throw new Error(`logs request failed: ${res.status}`);
  const body = (await res.json()) as { events: DashboardEvent[] };
  return body.events;
}

const EVENT_NAMES = [
  'log',
  'request',
  'response',
  'status',
  'llm.trace.start',
  'llm.trace.token',
  'llm.trace.complete',
  'llm.trace.think.start',
  'llm.trace.think.token',
  'llm.trace.think.complete',
  'stats.updated',
] as const;

/**
 * Open one EventSource('/api/events') and dispatch each named event to
 * `onEvent`, reconstructing the full event object (the SSE frame carries the
 * type as the event name and the remainder as JSON data). Returns a close fn.
 */
export function openEventStream(onEvent: (event: DashboardEvent) => void): () => void {
  const es = new EventSource('/api/events');
  const handler = (raw: MessageEvent<string>): void => {
    try {
      const data = JSON.parse(raw.data) as Record<string, unknown>;
      onEvent({ type: raw.type, ...data } as unknown as DashboardEvent);
    } catch {
      // ignore malformed frames
    }
  };
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, handler);
  }
  return () => es.close();
}
