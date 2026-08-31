import { defineStore } from 'pinia';
import { getLogs, getStats, getStatus, openEventStream } from './api';
import type { DashboardEvent, StatsPayload, ToolStatus } from './types';

export interface Trace {
  id: string;
  model: string;
  request: string;
  tokens: string;
  thinking: string;
  complete: boolean;
}

export const useDashboardStore = defineStore('dashboard', {
  state: () => ({
    status: [] as ToolStatus[],
    stats: null as StatsPayload | null,
    logs: [] as DashboardEvent[],
    traces: [] as Trace[],
    connected: false,
    _unsubscribe: null as (() => void) | null,
  }),
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
        case 'request':
        case 'response':
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
          const trace = this.traces.find((t) => t.id === event.id);
          if (trace) trace.thinking = '';
          break;
        }
        case 'llm.trace.think.token': {
          const trace = this.traces.find((t) => t.id === event.id);
          if (trace) trace.thinking += event.delta;
          break;
        }
        case 'llm.trace.think.complete':
          // thinking already accumulated into the trace
          break;
      }
    },
  },
});
