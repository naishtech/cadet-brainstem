import { loadConfig } from '../config';
import { getEventBus, type EventBus } from './event-bus';

/** Max hint length when `dashboard.captureFull` is false (design §10). */
export const HINT_LIMIT = 120;

export type InstrumentLogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Non-blocking, never-throwing facade over the EventBus for instrumenting the
 * four live sources (design doc §5.4, Task 52). Honours `dashboard.captureFull`
 * by truncating `inputHint`/`outputHint` when full capture is off.
 */
export interface Instrumenter {
  requestStarted(input: {
    id: string;
    tool: string;
    operation: string;
    inputHint?: string;
  }): void;
  responded(input: {
    id: string;
    ok: boolean;
    latencyMs?: number;
    outputHint?: string;
  }): void;
  log(level: InstrumentLogLevel, source: string, message: string): void;
  statsUpdated(): void;
}

function truncateHint(value: string | undefined, captureFull: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (captureFull) return value;
  return value.length > HINT_LIMIT ? `${value.slice(0, HINT_LIMIT)}…` : value;
}

export interface CreateInstrumenterOptions {
  captureFull?: boolean;
  eventBus?: EventBus;
}

/** Create an instrumenter, resolving captureFull from config when not given. */
export function createInstrumenter(
  options: CreateInstrumenterOptions = {},
): Instrumenter {
  let captureFull = options.captureFull;
  if (captureFull === undefined) {
    try {
      captureFull = loadConfig().dashboard.captureFull;
    } catch {
      captureFull = true;
    }
  }
  const bus = options.eventBus ?? getEventBus();

  return {
    requestStarted(input) {
      try {
        const hint = truncateHint(input.inputHint, captureFull);
        const base = { id: input.id, tool: input.tool, operation: input.operation };
        bus.requestStarted(hint === undefined ? base : { ...base, inputHint: hint });
      } catch {
        /* instrumentation is best-effort */
      }
    },
    responded(input) {
      try {
        const hint = truncateHint(input.outputHint, captureFull);
        const base = {
          id: input.id,
          ok: input.ok,
          ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        };
        bus.responded(hint === undefined ? base : { ...base, outputHint: hint });
      } catch {
        /* instrumentation is best-effort */
      }
    },
    log(level, source, message) {
      try {
        bus.log(level, source, message);
      } catch {
        /* instrumentation is best-effort */
      }
    },
    statsUpdated() {
      try {
        bus.statsUpdated();
      } catch {
        /* instrumentation is best-effort */
      }
    },
  };
}

let instrumenter: Instrumenter | undefined;

/** Lazily-created process-wide instrumenter configured from dashboard config. */
export function getInstrumenter(): Instrumenter {
  if (instrumenter === undefined) {
    instrumenter = createInstrumenter();
  }
  return instrumenter;
}
