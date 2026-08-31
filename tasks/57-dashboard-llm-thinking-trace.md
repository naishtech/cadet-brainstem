# Task 57 — Dashboard LLM thinking trace (procedures-only)

**Risk rationale:** Medium — touches classifier streaming, the trace event model, the web
store, and the trace view. Opt-in and gated to procedure execution, so the default routing
path is unchanged.

**Status:** Not started
**Phase:** Phase 15
**Source:** `docs/plans/dashboard-llm-thinking-trace.md` (split into tasks 57–59)
**Order:** after task 59 (rename); before task 58 (logging rework)

## Objective

Show the local model's **internal reasoning** ("thinking") live on the dashboard, scoped to
where it adds the most value: **procedure execution**. When the model runs a reusable
procedure (filling arguments, deciding a replacement, executing a multi-step sequence), stream
its reasoning deltas to the dashboard as a separate, readable "Thinking" panel per trace.

Cheap routing calls (`classify`, `assess_context`) stay `think: false` — thinking there only
adds latency/tokens for a trivial decision. Because thinking costs tokens and latency, it is
**opt-in** (default OFF) and gated to procedure execution.

## Details

1. **Config (opt-in):** add `classifier.think?: boolean` (zod, default `false`) — streams
   reasoning on procedure-execution classifier calls. Routing `classify`/`assess` always send
   `think: false`.
2. **Trace events:** add `llm.trace.think.start` / `llm.trace.think.token` /
   `llm.trace.think.complete` to the `EventBus` `DashboardEvent` union + `traceThink*` helpers;
   add `TraceSink.thinkStart/thinkToken/thinkComplete` in `src/dashboard/trace.ts`.
3. **Classifier streaming (`src/classifier/ollama.ts`):** when thinking is enabled, read
   `message.reasoning_content` (qwen3; fall back to `message.thinking`) per NDJSON frame and
   emit think tokens separately from output. Capture reasoning in the non-streaming fallback
   (`chatOnce`) too.
4. **Wire to procedure execution (`src/procedure/execute.ts`):** attach the dashboard
   `TraceSink` and send `think: true` (when `classifier.think`) on fill-args so reasoning
   streams while a procedure runs.
5. **Web store (`web/src/store.ts`):** `Trace` gains a `thinking` accumulator; on
   `llm.trace.think.token` append the delta.
6. **Web view (`web/src/components/LlmTraceView.vue`):** add a collapsible "Thinking" panel per
   trace (shown when `thinking` is non-empty), distinct from the output.

### CLI option + dashboard toggle
- **CLI:** implement the `config` command (currently a stub) with `get`/`set`, e.g.
  `cadet-brainstem config set classifier.think true|false` (via `saveConfig`).
- **Dashboard toggle:** a header switch backed by `GET/POST /api/config/classifier/think`
  (persist via `saveConfig`); the web store renders/toggles it. Takes effect on the next
  procedure run.

## Files

- `src/config/config.ts` — `classifier.think` schema + default
- `src/classifier/ollama.ts` — `think` + `reasoning_content` streaming + think trace events
- `src/dashboard/trace.ts`, `src/dashboard/event-bus.ts` — think event types + helpers
- `src/procedure/execute.ts` — attach `TraceSink` + `think: true` on fill-args
- `src/cli/commands/config.ts` — `get`/`set` (stub → implemented)
- `src/dashboard/server.ts` — `/api/config/classifier/think`
- `web/src/store.ts`, `web/src/components/LlmTraceView.vue` — `thinking` + collapsible panel
- `web/src/App.vue` — header toggle switch

## Test Updates

- `test/classifier-stream.test.ts` — think:true streams `reasoning_content` → think tokens;
  non-streaming fallback captures reasoning
- `test/dashboard-trace.test.ts`, `test/dashboard-event-bus.test.ts` — think event types
- `test/config-command.test.ts` — `config get/set classifier.think`
- `test/dashboard-server.test.ts` — `/api/config/classifier/think`
- `web/src/components/__tests__/LlmTraceView.test.ts` — thinking panel + header toggle

## Acceptance Criteria

- [ ] `npm test` (backend) + `cd web && npm test` — all pass.
- [ ] `npm run build` — backend + web static build.
- [ ] With `classifier.think: true` (CLI or toggle), running a procedure streams the model's
      reasoning live in a "Thinking" panel, then the step output.
- [ ] Routing `classify`/`assess` stay `think: false` (fast); default `think: false` changes
      nothing.
