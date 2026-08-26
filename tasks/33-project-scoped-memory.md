# Task 33 — Project-scoped memory

**Risk rationale:** The memory store is a single global SQLite db shared by
every project, so one project's agent can read (or `memory clear` wipe) another
project's facts. Scoping it per project by default prevents contamination and
accidental cross-project clears.

**Status:** Implemented on branch `task/33-project-scoped-memory` (pending review/commit)
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §17 Chat memory store

## Objective

Scope memories to a project by default (a cwd-derived project id), with
`__global__` as the explicit cross-project scope.

## Details

- `src/memory/project.ts` — `GLOBAL_PROJECT = '__global__'` + `resolveProjectId(cwd)`:
  `package.json` name → git origin remote (normalised) → `<basename>-<hash8>`.
  Reads files only; never shells out.
- `MemoryStore.count(project?)` and `MemoryStore.clear(project?)` — optional
  project scoping (no project = all).
- MCP: `McpDeps.defaultProject` (defaults to `resolveProjectId(process.cwd())`);
  `chat_memory_store` `store`/`search`/`list` default `project` to it.
  `get`/`update`/`delete` remain id-based (UUIDs are globally unique).
- CLI `memory`: `[clear] [--project <name>] [--all]`. Stats and clear scope to
  the current project by default; `--all` clears every project.

## Acceptance Criteria

- [x] `resolveProjectId` resolves package.json name → git remote → fallback.
- [x] `count(project)` / `clear(project)` scope correctly.
- [x] `chat_memory_store` defaults to the cwd-derived project.
- [x] `memory clear` clears only the current project; `--all` clears everything.
- [x] Tests in `test/memory.test.ts`.
