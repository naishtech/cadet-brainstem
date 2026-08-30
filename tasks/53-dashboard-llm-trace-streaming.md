# Task 53 — Dashboard: LLM Trace Streaming

**Risk rationale:** Medium — changes the classifier's Ollama call to streaming; must keep a
non-streaming fallback.

**Status:** Done
**Phase:** Dashboard
**Source:** `docs/plans/dashboard.md` — §7 Streaming the LLM Trace

## Objective

Stream the LLM's reasoning to the dashboard in real time using Ollama's streaming chat API.

## Details

- Extend the classifier's Ollama call (`src/classifier/ollama.ts`) to use `/api/chat` with
  `stream: true` (NDJSON deltas).
- For each delta, emit `llm.trace.token` on the `EventBus`; forward reasoning/`thinking`
  content when the model emits it so the UI shows "how it thinks".
- Emit `llm.trace.start` (id, model, request) and `llm.trace.complete` (id, token usage).
- **Graceful degradation:** on any streaming error, fall back to the existing non-streaming
  path and emit a single `llm.trace.complete` with the full output (mirror
  `src/classifier/degradation.ts` patterns).
- Respect `dashboard.captureFull` for trace content.

## Acceptance Criteria

- [x] Reasoning tokens stream live as `llm.trace.token` events.
- [x] `llm.trace.start`/`complete` bracket each classification.
- [x] Streaming failure falls back to non-streaming without breaking classification.
- [x] No regression in existing classifier tests.
