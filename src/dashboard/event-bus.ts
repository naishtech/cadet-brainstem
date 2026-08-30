import { EventEmitter } from 'node:events';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import type { ToolAvailability } from '../core/environment';
import { loadConfig } from '../config';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Discriminated union of every live dashboard event (design doc §5.3).
 * All events carry `ts` (epoch ms) so the ring buffer and SSE replay can order
 * and filter them.
 */
export type DashboardEvent =
  | { type: 'log'; level: LogLevel; ts: number; source: string; message: string }
  | {
      type: 'request';
      ts: number;
      id: string;
      tool: string;
      operation: string;
      inputHint?: string;
    }
  | {
      type: 'response';
      ts: number;
      id: string;
      ok: boolean;
      latencyMs?: number;
      outputHint?: string;
    }
  | { type: 'status'; ts: number; services: ToolAvailability[] }
  | { type: 'llm.trace.start'; ts: number; id: string; model: string; request: string }
  | { type: 'llm.trace.token'; ts: number; id: string; delta: string }
  | { type: 'llm.trace.complete'; ts: number; id: string; usage?: LlmUsage }
  | { type: 'stats.updated'; ts: number };

export interface EventBusOptions {
  /** In-memory ring buffer capacity (config `dashboard.logRetention`). */
  capacity: number;
  /** When true, append each event as a JSON line to `persistPath`. */
  persistLogs: boolean;
  /** JSONL file appended to when `persistLogs` is true. */
  persistPath: string;
}

export const DEFAULT_EVENT_BUS_OPTIONS: EventBusOptions = {
  capacity: 500,
  persistLogs: true,
  persistPath: join(os.homedir(), '.cadet-brainstem', 'dashboard.log'),
};

/** Stable JSONL log path (design doc §8 `persistLogs`). */
export function getDashboardLogPath(): string {
  return join(os.homedir(), '.cadet-brainstem', 'dashboard.log');
}

function now(): number {
  return Date.now();
}

/**
 * Process-wide event bus (design doc §5.3). Fans events out to subscribers,
 * keeps a bounded in-memory ring buffer for `/api/logs` + SSE replay, and
 * optionally appends each event as a JSON line for durable local logs.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly options: EventBusOptions;
  private buffer: DashboardEvent[] = [];
  /** Content keys of events already buffered/published (dedup for JSONL re-ingest). */
  private readonly seen = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: EventBusOptions) {
    this.options = { ...options };
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(fn: (event: DashboardEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => {
      this.emitter.off('event', fn);
    };
  }

  /** Publish an event: fan out to subscribers, buffer it, and persist. */
  publish(event: DashboardEvent): void {
    this.seen.add(this.keyOf(event));
    this.push(event);
    this.emitter.emit('event', event);
    if (this.options.persistLogs) {
      this.enqueuePersist(event);
    }
  }

  /**
   * Ingest an event read back from the persisted JSONL (written by another
   * process, e.g. a short-lived Copilot hook). Adds it to the ring buffer and
   * broadcasts it, but never re-persists it. Events this process already
   * published are skipped (dedup) so its own persisted lines aren't doubled.
   */
  ingestExternal(event: DashboardEvent, broadcast = true): void {
    const key = this.keyOf(event);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.push(event);
    if (broadcast) this.emitter.emit('event', event);
  }

  private push(event: DashboardEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.options.capacity) {
      this.buffer.splice(0, this.buffer.length - this.options.capacity);
    }
  }

  private keyOf(event: DashboardEvent): string {
    return JSON.stringify(event);
  }

  /**
   * Recent buffered events, newest-first. `limit` caps the count; `since` is an
   * inclusive timestamp filter (older events are skipped).
   */
  recent(limit = 100, since?: number): DashboardEvent[] {
    const out: DashboardEvent[] = [];
    for (let i = this.buffer.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const event = this.buffer[i] as DashboardEvent;
      if (since !== undefined && event.ts < since) break;
      out.push(event);
    }
    return out;
  }

  /** Number of events currently buffered. */
  size(): number {
    return this.buffer.length;
  }

  /** Capacity of the ring buffer. */
  capacity(): number {
    return this.options.capacity;
  }

  /** Resolve once all pending JSONL writes have flushed. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ── Convenience emitters ────────────────────────────────────────────────

  log(level: LogLevel, source: string, message: string): void {
    this.publish({ type: 'log', level, ts: now(), source, message });
  }

  requestStarted(input: {
    id: string;
    tool: string;
    operation: string;
    inputHint?: string;
  }): void {
    this.publish({ type: 'request', ts: now(), ...input });
  }

  responded(input: {
    id: string;
    ok: boolean;
    latencyMs?: number;
    outputHint?: string;
  }): void {
    this.publish({ type: 'response', ts: now(), ...input });
  }

  status(services: ToolAvailability[]): void {
    this.publish({ type: 'status', ts: now(), services });
  }

  traceStart(input: { id: string; model: string; request: string }): void {
    this.publish({ type: 'llm.trace.start', ts: now(), ...input });
  }

  traceToken(input: { id: string; delta: string }): void {
    this.publish({ type: 'llm.trace.token', ts: now(), ...input });
  }

  traceComplete(input: { id: string; usage?: LlmUsage }): void {
    this.publish({ type: 'llm.trace.complete', ts: now(), ...input });
  }

  statsUpdated(): void {
    this.publish({ type: 'stats.updated', ts: now() });
  }

  private enqueuePersist(event: DashboardEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    // Serialize appends so lines never interleave; best-effort and non-fatal.
    this.writeChain = this.writeChain
      .then(() => appendFile(this.options.persistPath, line, 'utf8'))
      .catch(() => {
        /* persistence is best-effort */
      });
  }
}

let singleton: EventBus | undefined;

/**
 * Lazily-created process-wide singleton (design doc §5.3), configured from the
 * `dashboard` config block on first access.
 */
export function getEventBus(): EventBus {
  if (singleton === undefined) {
    singleton = createEventBusFromConfig();
  }
  return singleton;
}

/** Create an `EventBus` configured from the current dashboard config. */
export function createEventBusFromConfig(): EventBus {
  try {
    const cfg = loadConfig();
    return new EventBus({
      capacity: cfg.dashboard.logRetention,
      persistLogs: cfg.dashboard.persistLogs,
      persistPath: getDashboardLogPath(),
    });
  } catch {
    return new EventBus(DEFAULT_EVENT_BUS_OPTIONS);
  }
}
