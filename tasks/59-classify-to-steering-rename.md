# Task 59 — Rename Classify → Steering (full)

**Risk rationale:** High — breaking rename across the MCP tool registry, classifier module,
config, hooks, docs, and tests. Done first (before tasks 57–58) so the later tasks are written
in the new "steering" naming and need no further rename.

**Status:** Not started
**Phase:** Phase 15
**Source:** `docs/plans/dashboard-llm-thinking-trace.md` §9.2 (split into tasks 57–59)

## Objective

Rename the `classify` concept to **`steering`** across the codebase — full rename, including
the MCP tool name. This is a deliberate conceptual shift: the model doesn't just classify a
request, it steers how the agent should approach it (strategy, tool plan, response policy).

## Details

1. **MCP tool:** `classify` → `steering` in `TOOL_DEFS` (name + description),
   `handleToolCall` case, and `classifyTool` → `steerTool`.
2. **Classifier:** `classify()` → `steer()`, `classifyWithFallback` → `steerWithFallback`,
   `classifyOrDegrade` → `steerOrDegrade`, `Classification` → `Steering` (output type), and the
   `src/classifier/` module → `src/steering/`. Update all re-exports/imports.
3. **Config:** `classifier` key → `steering` (schema, `defaultConfig`, env overrides).
4. **Hooks:** `hook-user-prompt` steers (calls `steering`); update hook descriptions and the
   generated `~/.copilot/hooks/cadet-brainstem.json`.
5. **Docs/steering:** `AGENTS.md`, `README`, `docs/integration-vscode.md`,
   `docs/requirements.md` — "call classify first" → "call steering first".
6. **Compatibility:** breaking change → bump minor version (e.g. 0.3.0); update
   `.vscode/mcp.json`. Add a temporary `classify` → `steering` alias for migration.

## Files

- `src/mcp/server.ts` — tool registry + `steerTool`
- `src/classifier/**` → `src/steering/**` (module rename + identifiers)
- `src/config/config.ts` — `steering` key
- `src/cli/commands/hook-*.ts`, `src/cli/commands/hooks.ts` — steers, descriptions
- `AGENTS.md`, `README.md`, `docs/**` — steering wording
- `.vscode/mcp.json` — tool name
- All `test/classify*.test.ts` + `classifyTool` cases in `test/mcp-server.test.ts`,
  `test/policy.test.ts`, `test/roundtrip.test.ts`, `test/hook-*.test.ts`

## Test Updates

- Rename/update every `classify*` test and assertion (`classifyTool`, `classify()`,
  `classifyWithFallback`, `Classification`, etc.).
- Add a migration/alias test for `classify` → `steering` if the alias is kept.

## Acceptance Criteria

- [ ] `npm test` — all suites pass after the rename (no `classify`-only identifiers remain).
- [ ] `npm run build` — no type errors from renamed symbols/modules.
- [ ] `steering` tool works end-to-end (MCP + hooks); `classify` alias works during migration
      if kept.
- [ ] Docs/AGENTS updated to "call steering first".
