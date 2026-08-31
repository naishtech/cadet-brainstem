import type { TraceSink } from '../classifier';
import { getEventBus, type EventBus } from './event-bus';

/**
 * Build a TraceSink that publishes LLM trace events to the EventBus so the
 * dashboard's SSE stream can render reasoning live (design doc §7). Never
 * throws — instrumentation is best-effort.
 */
export function getTraceSink(bus: EventBus = getEventBus()): TraceSink {
  return {
    start(info) {
      try {
        bus.traceStart(info);
      } catch {
        /* best-effort */
      }
    },
    token(info) {
      try {
        bus.traceToken(info);
      } catch {
        /* best-effort */
      }
    },
    complete(info) {
      try {
        bus.traceComplete(
          info.usage !== undefined ? { id: info.id, usage: info.usage } : { id: info.id },
        );
      } catch {
        /* best-effort */
      }
    },
    thinkStart(info) {
      try {
        bus.traceThinkStart({ id: info.id });
      } catch {
        /* best-effort */
      }
    },
    thinkToken(info) {
      try {
        bus.traceThinkToken({ id: info.id, delta: info.delta });
      } catch {
        /* best-effort */
      }
    },
    thinkComplete(info) {
      try {
        bus.traceThinkComplete({ id: info.id });
      } catch {
        /* best-effort */
      }
    },
  };
}
