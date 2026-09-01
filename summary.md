# Cadet Brainstem — Project Status

Local steering + procedure layer that reduces AI coding agent context and tool output.
Ships as a local MCP server (`cadet-brainstem mcp`) and a command wrapper (`cadet-brainstem wrap`).
v0.2.0 · MIT · Node.js 18+ · local-first.

## Built
- **Steering** — Ollama-based request steering returning optimisation strategy, tool plan, and response policy.
- **Context optimisation** — LeanCTX-compressed reads with token-savings metrics.
- **Memory** — per-project local SQLite agent memory (`chat_memory_store`, `activate_project`).
- **Procedures** — review-gated write procedures (`procedure_review` / `procedure_apply`).
- **Tooling** — CLI (`init`, `doctor`, `stats`, `memory`, `procedure`, `mine`, `hooks`, `mcp`), MCP server, VS Code integration, Vitest test suite, tsup build, npm publish.

## Next steps
- Remaining roadmap in `tasks/`: telemetry interface, dashboard web UI, npm publish, etc.
