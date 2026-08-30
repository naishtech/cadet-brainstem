/**
 * Local-LLM (Ollama) availability state machine.
 *
 * The MCP server warms the model at startup (fire-and-forget) so the first
 * `classify` call doesn't pay the cold-load latency (which can take minutes).
 * Until the model is `ready`, tools should fail fast — returning conservative
 * defaults plus a "warming up / down" notice — rather than stalling the cloud
 * LLM on a request that can't succeed within the classifier timeout.
 *
 * Transitions (kept intentionally simple):
 *   unknown -> warming (warm-up kicked off at server start)
 *   warming -> ready  (model loaded, warm-up request succeeded)
 *   warming -> down    (Ollama unreachable / warm-up failed)
 */
export type LlmStatus = 'unknown' | 'warming' | 'ready' | 'down';

/** Threaded through `McpDeps` so every tool handler sees the same status. */
export class LlmStatusTracker {
  private _status: LlmStatus = 'unknown';

  get status(): LlmStatus {
    return this._status;
  }

  set(status: LlmStatus): void {
    this._status = status;
  }

  /** True when the model is loaded and can serve requests immediately. */
  isReady(): boolean {
    return this._status === 'ready';
  }

  /** True when requests should fall back to fast conservative defaults. */
  isUnavailable(): boolean {
    return this._status === 'warming' || this._status === 'down';
  }
}
