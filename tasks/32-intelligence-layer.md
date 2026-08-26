# Task 32 — Intelligence layer: classify as a stateless controller

**Risk rationale:** Turns the single-shot classifier into a controller that
decides *what signal the cloud model needs next*, closing the loop with tool
results. Highest token-saving leverage in the system, and the largest
architectural change.

**Status:** Not started
**Phase:** Phase 14
**Source:** `docs/plans/initial_design.md` — §16 Integration, §17 Chat memory store

## Objective

Evolve `classify` from a stateless one-shot classifier into a **stateless
controller** that, per request, decides what information the cloud model needs
next, using tool-result feedback and short working memory — with **no
in-process state**.

Objective: **maximise signal delivered per token**, sized to what the task
needs (not "save tokens" — more tokens is correct when the task needs them).

## Design

The controller answers one question on every run:

> What information should the expensive thinker see next?

Not "what is the answer" — only "what context, at what fidelity". It can be
wrong about the task and still be useful: it routes, filters and shapes.

```
user request → classify → tool_plan
                        ↓
             tools (RTK=noise, Serena=signal, LeanCTX=shape)
                        ↓
             result metadata (sizes, symbols, files, degraded)
                        ↓
             MetricsStore (append-only, keyed by request_id)
                        ↓
             assess_context → rebuild inventory → local LLM
                        ↓
             verdict: continue (new tool_plan) | stop (context ready)
                        ↓
             cloud LLM
```

## Details

- **Objective reframe (prompt only)** — instruct the model to size context to
  the task ("do not over-trim"); optionally emit a `budget_tokens` band mapped
  from `context_need` (minimal/targeted/broad/exhaustive).
- **`request_id` threading** — stamp one shared `request_id` on EVERY tool
  metrics event (`classify`, `optimize_context`, `serena`, `rtk`, `memory`,
  `assess_context`) so a request's inventory can be rebuilt. Already present
  on classify↔optimize_context; extend to the rest.
- **`assess_context` MCP tool** — `assess_context({ request_id })`:
  - rebuild the inventory from `MetricsStore` (SELECT by `request_id`, order
    by timestamp): tool, operation, input/output tokens, symbols_found,
    files_found, degraded;
  - feed a compact (≤~300 token) inventory summary to the local LLM;
  - return `{ verdict: "continue" | "stop", tool_plan, reason }`.
  - The server stays **stateless** — SQLite is the working memory; nothing
    lives in the process.
- **Single-shot fallback** — when Ollama is unavailable, return the existing
  one-shot `classify` plan (no loop). The loop is a degraded-mode upgrade.
- **rank / dedupe / format (later)** — dedupe overlapping paths/sizes
  rule-based first; assemble the final context block via LeanCTX map mode.
- **Sufficiency proxy** — "context churn": repeated fetches of the same target
  within one `request_id` (measurable now from MetricsStore) as a stand-in for
  task success.

## Acceptance Criteria

- [x] `request_id` is recorded on every tool metrics event.
- [x] `assess_context` rebuilds the inventory from MetricsStore by
      `request_id` and returns a `continue`/`stop` verdict + `tool_plan`
      with **no in-process state** (two calls share nothing).
- [x] Degraded path (Ollama down) returns `verdict: "stop"` (no loop).
- [x] Steering (`AGENTS.md`) documents the loop (classify → tools →
      assess_context).
- [x] Unit tests: inventory reconstruction from a seeded metrics db;
      assess_context verdict logic with a mocked classifier; statelessness
      (no shared mutable state between calls).
