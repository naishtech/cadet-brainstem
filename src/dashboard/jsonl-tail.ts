import { readFile } from 'node:fs/promises';
import type { DashboardEvent, EventBus } from './event-bus';

/**
 * Bridge the persisted dashboard JSONL into a running EventBus.
 *
 * The dashboard server and the short-lived Copilot hook processes each have
 * their own in-memory EventBus, but all of them persist every event as a JSON
 * line to the same `dashboard.log`. This tailer lets the dashboard server read
 * that shared file so events emitted by *other* processes (e.g. the
 * `hook-user-prompt` classify) show up on the live dashboard (design §7 /
 * process-isolation fix).
 *
 * On start it hydrates the whole file into the bus (no broadcast), then polls
 * for appended lines and broadcasts them. The bus dedups by content key, so
 * the dashboard's own persisted events are not double-broadcast.
 */
export class JsonlTailer {
  private readonly path: string;
  private readonly bus: EventBus;
  private readonly intervalMs: number;
  private offset = 0;
  private pending = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(options: { path: string; bus: EventBus; intervalMs?: number }) {
    this.path = options.path;
    this.bus = options.bus;
    this.intervalMs = options.intervalMs ?? 1000;
  }

  /** Begin hydrating + polling. Best-effort and never throws. */
  start(): void {
    void this.poll(false);
    this.timer = setInterval(() => this.poll(true), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(broadcast: boolean): Promise<void> {
    try {
      const data = await readFile(this.path, 'utf8');
      if (data.length < this.offset) {
        // File was truncated/rotated — restart from the beginning.
        this.offset = 0;
        this.pending = '';
      }
      const chunk = data.slice(this.offset);
      this.offset = data.length;
      if (chunk.length === 0) return;

      this.pending += chunk;
      const lines = this.pending.split('\n');
      this.pending = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const event = JSON.parse(trimmed) as DashboardEvent;
          this.bus.ingestExternal(event, broadcast);
        } catch {
          // Skip malformed/partial lines.
        }
      }
    } catch {
      // File not present yet — ignore.
    }
  }
}
