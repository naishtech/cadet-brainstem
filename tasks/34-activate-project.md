# Task 34 — `activate_project` + per-project memory storage

**Risk rationale:** Mirrors Serena's project-activation model so memory is
stored per project (not one global db), eliminating cross-project reads/wipes
and giving the agent an explicit way to switch scope.

**Status:** In progress
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §17 Chat memory store

## Objective

Store memories in a per-project directory `.cadet/token-saver/` (like Serena's
`.serena/`), with an `activate_project` step that sets the active project, and
a `__global__` scope for cross-project facts.

## Details

- Per-project memory db: `<project-root>/.cadet/token-saver/memory.db`
  (gitignored via `.cadet/`). Global facts stay in `~/.cadet-token-saver/memory.db`.
- `src/memory/project.ts`: `resolveProjectRoot(cwd)` (nearest ancestor with
  `package.json`/`.git`), `getProjectMemoryPath(root)`, `resolveMemoryDbPath`.
- Config gains a `memory` section: `active_project` (path) + `projects`
  (name → path registry).
- MCP `activate_project({ project })`: resolves a path/name to a project root,
  persists it as `memory.active_project`, returns `{ project, root, memory_db }`.
- `chat_memory_store` opens the db resolved from: explicit `project` arg →
  active project → cwd; `project: "__global__"` uses the global db.
- CLI `memory`: `[clear] [--project <name>] [--global]`.

## Acceptance Criteria

- [ ] `.cadet/token-saver/memory.db` is used per project; `.cadet/` is gitignored.
- [ ] `activate_project` resolves + persists the active project.
- [ ] `chat_memory_store` and `memory` CLI default to the project db, with
      `__global__` as the explicit global scope.
- [ ] Tests in `test/memory.test.ts` + `test/mcp-server.test.ts`.
