# Project Status — Cadet Brainstem

**Version:** 0.2.0 · MIT · Node.js 18+ · local-first

## What it is
A local steering + procedure layer that reduces the context and tool output an
AI coding agent consumes, and records how many tokens are saved.

## Current state
- **Wired CLI commands:** `init`, `doctor`, `stats`, `memory`, `mine`,
  `procedure`, `hooks` (+ `hook-*` handlers), `mcp`.
  (`config`, `dashboard`, `telemetry` remain scaffolded or partial.)
- **MCP tools exposed:** `steering`, `optimize_context`, `chat_memory_store`,
  `activate_project`, `assess_context`, `procedure_review`, `procedure_apply`.
- **Pipeline:** task → steering (Ollama `qwen3:4b`) → policy → LeanCTX →
  optimised context + `metrics.db`.
- **Degradation:** falls back to conservative defaults when Ollama is missing.

## Notable features
- Deterministic policy engine (LLM classifies; it never decides how to optimise).
- Local SQLite stores for metrics and agent memory (per-project scoping).
- Reusable procedures with approval-gated write steps (review → apply).

## Build / test
```bash
npm run build      # tsup bundle
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
```
