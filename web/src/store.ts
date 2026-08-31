import { defineStore } from 'pinia';
import { getLogs, getStats, getStatus, openEventStream } from './api';
import type { DashboardEvent, EventCategory, StatsPayload, ToolStatus } from './types';

export interface Trace {
  id: string;
  model: string;
  request: string;
  tokens: string;
  thinking: string;
  complete: boolean;
  category: EventCategory;
}

/** Map an MCP `operation` (tool request) to a dashboard stream category. */
function categoryForOperation(operation: string): EventCategory {
  if (operation === 'steering' || operation === 'assess_context' || operation === 'optimize_context') {
    return 'steering';
  }
  if (operation.startsWith('procedure')) return 'procedures';
  return 'system';
}

/** Categorize any dashboard event into a stream, resolving responses by request id. */
function categoryOfEvent(
  event: DashboardEvent,
  reqCat: Record<string, EventCategory>,
): EventCategory {
  switch (event.type) {
    case 'log':
    case 'status':
    case 'stats.updated':
      return 'system';
    case 'request':
      return categoryForOperation(event.operation);
    case 'response':
      return reqCat[event.id] ?? 'system';
    case 'llm.trace.think.start':
    case 'llm.trace.think.token':
    case 'llm.trace.think.complete':
      // Thinking only happens during procedure execution (task 57).
      return 'procedures';
    case 'llm.trace.start':
    case 'llm.trace.token':
    case 'llm.trace.complete':
      // Non-thinking LLM traces come from steering calls.
      return 'steering';
  }
}

export const useDashboardStore = defineStore('dashboard', {
  state: () => ({
    status: [] as ToolStatus[],
    stats: null as StatsPayload | null,
    logs: [] as DashboardEvent[],
    traces: [] as Trace[],
    connected: false,
    _unsubscribe: null as (() => void) | null,
    /** request id -> category, so paired `response` events land in the right stream. */
    _reqCat: {} as Record<string, EventCategory>,
  }),
  getters: {
    steeringLogs(state): DashboardEvent[] {
      return state.logs.filter((e) => categoryOfEvent(e, state._reqCat) === 'steering');
    },
    procedureLogs(state): DashboardEvent[] {
      return state.logs.filter((e) => categoryOfEvent(e, state._reqCat) === 'procedures');
    },
    steeringTraces(state): Trace[] {
      return state.traces.filter((t) => t.category === 'steering');
    },
    procedureTraces(state): Trace[] {
      return state.traces.filter((t) => t.category === 'procedures');
    },
  },
  actions: {
    async refreshStatus(): Promise<void> {
      this.status = await getStatus();
    },
    async refreshStats(): Promise<void> {
      this.stats = await getStats();
    },
    async loadLogs(): Promise<void> {
      this.logs = await getLogs();
    },
    connect(): void {
      void this.refreshStatus();
      void this.refreshStats();
      void this.loadLogs();
      this.connected = true;
      this._unsubscribe = openEventStream((event) => this.handleEvent(event));
    },
    disconnect(): void {
      this._unsubscribe?.();
      this.connected = false;
    },
    handleEvent(event: DashboardEvent): void {
      switch (event.type) {
        case 'status':
          this.status = event.services;
          break;
        case 'stats.updated':
          void this.refreshStats();
          break;
        case 'log':
        case 'response':
          this.logs.push(event);
          if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
          break;
        case 'request':
          this._reqCat[event.id] = categoryForOperation(event.operation);
          this.logs.push(event);
          if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
          break;
        case 'llm.trace.start':
          this.traces.push({
            id: event.id,
            model: event.model,
            request: event.request,
            tokens: '',
            thinking: '',
            complete: false,
            category: 'steering',
          });
          break;
        case 'llm.trace.token': {
          const trace = this.traces.find((t) => t.id === event.id);
          if (trace) trace.tokens += event.delta;
          break;
        }
        case 'llm.trace.complete': {
          const trace = this.traces.find((t) => t.id === event.id);
          if (trace) trace.complete = true;
          break;
        }
        case 'llm.trace.think.start': {
          // Procedures stream thinking without a preceding llm.trace.start, so
          // create the trace lazily so it shows under the Procedures stream.
          const trace = this.traces.find((t) => t.id === event.id);
          if (trace) {
            trace.thinking = '';
          } else {
            this.traces.push({
              id: event.id,
              model: 'procedure',
              request: '',
              tokens: '',
              thinking: '',
              complete: false,
              category: 'procedures',
            });
          }
          break;
        }
        case 'llm.trace.think.token': {
          const trace =
            this.traces.find((t) => t.id === event.id) ??
            (() => {
              const created: Trace = {
                id: event.id,
                model: 'procedure',
                request: '',
                tokens: '',
                thinking: '',
                complete: false,
                category: 'procedures',
              };
              this.traces.push(created);
              return created;
            })();
          trace.thinking += event.delta;
          break;
        }
        case 'llm.trace.think.complete':
          // thinking already accumulated into the trace
          break;
      }
    },
  },
});
