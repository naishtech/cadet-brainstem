# Task 57 — Dashboard LLM thinking trace (procedures-only)

**Risk rationale:** Medium — touches classifier streaming, the trace event model, the web
store, and the trace view. Gated to procedure execution, so the routing path is unchanged.

**Status:** Done — implemented & merged (PR #54 backend, PR #55 web/always-on)
**Phase:** Phase 15
**Source:** `docs/plans/dashboard-llm-thinking-trace.md` (split into tasks 57–59)
**Order:** after task 59 (rename); before task 58 (logging rework)

## Objective

Show the local model's **internal reasoning** ("thinking") live on the dashboard, scoped to
where it adds the most value: **procedure execution**. When the model runs a reusable
procedure (filling arguments, deciding a replacement, executing a multi-step sequence), stream
its reasoning deltas to the dashboard as a separate, readable "Thinking" panel per trace.

Cheap routing calls (`classify`, `assess_context`) stay `think: false` — thinking there only
adds latency/tokens for a trivial decision. It is **always-on for procedures**: running a
procedure always streams its reasoning (no toggle).

## Details

1. **Always-on policy (no toggle):** routing `classify`/`assess` always send `think: false`;
   procedure fill-args always send `think: true`. No config flag, CLI toggle, or dashboard
   switch (removed for simplicity).
2. **Trace events:** add `llm.trace.think.start` / `llm.trace.think.token` /
   `llm.trace.think.complete` to the `EventBus` `DashboardEvent` union + `traceThink*` helpers;
   add `TraceSink.thinkStart/thinkToken/thinkComplete` in `src/dashboard/trace.ts`.
3. **Classifier streaming (`src/classifier/ollama.ts`):** when thinking is enabled, read
   `message.reasoning_content` (qwen3; fall back to `message.thinking`) per NDJSON frame and
   emit think tokens separately from output. Capture reasoning in the non-streaming fallback
   (`chatOnce`) too.
4. **Wire to procedure execution (`src/procedure/execute.ts`):** attach the dashboard
   `TraceSink` and always send `think: true` on fill-args so reasoning streams while a
   procedure runs.
5. **Web store (`web/src/store.ts`):** `Trace` gains a `thinking` accumulator; on
   `llm.trace.think.token` append the delta.
6. **Web view (`web/src/components/LlmTraceView.vue`):** add a collapsible "Thinking" panel per
   trace (shown when `thinking` is non-empty), distinct from the output.

### No CLI / dashboard toggle
Removed per design decision: thinking is always-on for procedures (and never for routing), so
there is no config flag, `config` command change, or dashboard switch.

## Files

- `src/config/config.ts` — no `classifier.think` (removed; unknown keys stripped)
- `src/classifier/ollama.ts` — `think: false` routing + `reasoning_content` streaming + think
  trace events
- `src/dashboard/trace.ts`, `src/dashboard/event-bus.ts` — think event types + helpers
- `src/procedure/execute.ts` — attach `TraceSink` + `think: true` on fill-args
- `web/src/store.ts`, `web/src/components/LlmTraceView.vue` — `thinking` + collapsible panel
- `web/src/api.ts` — SSE `EVENT_NAMES` includes the 3 think events

## Test Updates

- `test/procedure-thinking.test.ts` — procedures always publish think events; config
  assertions updated (no `classifier.think`)
- `test/config.test.ts` — removed `think:false` assertion
- `test/classifier-stream.test.ts` — routing stays `think: false` (unchanged)
- `web/src/components/__tests__/LlmTraceView.test.ts` — thinking panel (no toggle)

## Acceptance Criteria

- [x] `npm test` (backend) + `cd web && npm test` — all pass.
- [x] `npm run build` — backend + web static build.
- [x] Running a procedure always streams the model's reasoning live in a "Thinking" panel,
      then the step output.
- [x] Routing `classify`/`assess` stay `think: false` (fast); no default `think` to change.
