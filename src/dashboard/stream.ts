import type { ServerResponse } from 'node:http';

/**
 * A live SSE connection. `write` emits a named event with JSON data; `comment`
 * emits a heartbeat comment line; `close` ends the response.
 */
export interface SseConnection {
  write(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
}

/** Serialize a single SSE event frame as a string (unit-testable). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Serialize an SSE heartbeat comment line. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

/**
 * Upgrade an HTTP response into a Server-Sent-Events connection
 * (design doc §5.4). Multi-subscriber support is provided by the caller keeping
 * each `SseConnection`; every write here guards against a closed response.
 */
export function openSse(res: ServerResponse): SseConnection {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  return {
    write(event, data) {
      if (res.writableEnded) return;
      res.write(sseFrame(event, data));
    },
    comment(text) {
      if (res.writableEnded) return;
      res.write(sseComment(text));
    },
    close() {
      if (!res.writableEnded) res.end();
    },
  };
}
