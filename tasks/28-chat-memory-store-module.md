# Task 28 — Chat Memory Store: local SQLite module

**Risk rationale:** The persistence layer for agent memory — proves memories
can be stored, searched and updated locally and cheaply before wiring the MCP
endpoint.

**Status:** Not started
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §17 Chat memory store

## Objective

Build a local SQLite `MemoryStore` (mirroring the `MetricsStore` `node:sqlite`
approach) with CRUD + search, so the agent can persist facts that are expensive
to rediscover.

## Details

- `src/memory/store.ts` — `MemoryStore` backed by `node:sqlite` (not
  better-sqlite3), default path `~/.cadet-token-saver/memory.db`, overridable
  via `CADET_TOKEN_SAVER_MEMORY`.
- Schema: `memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT,
  project TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_accessed_at TEXT, hits INTEGER NOT NULL DEFAULT 0)`.
- Use the same `CREATE TABLE IF NOT EXISTS` + `migrate()` pattern as
  `MetricsStore` so future column additions upgrade in place.
- Methods:
  - `store({ content, tags?, project? }) → id` (generated id, e.g. UUID).
  - `update(id, { content?, tags? })` — returns whether the memory existed.
  - `get(id)` — bumps `last_accessed_at` / `hits`.
  - `search({ query?, tags?, project? })` — substring match on content +
    optional tag/project scoping (tags stored as JSON array in `tags`).
  - `list({ project?, limit? })` — most recently updated first.
  - `delete(id)` — returns whether it was removed.
  - `count()` — total memories (useful for `stats`/tests).
- `getDefaultMemoryPath()` (env override, mirroring `getDefaultMetricsPath`).
- Export everything from `src/memory/index.ts`.
- Code comment: never store secrets/credentials (safety §14) — the tool
  validates/normalises content but cannot police it; steering covers it.

## Acceptance Criteria

- [ ] `memory.db` is created on first use in the metrics directory.
- [ ] store → get → update → search → delete round-trip correctly (unit tested).
- [ ] search matches content substrings and scopes by tags/project.
- [ ] `get` bumps the hit counter / last-accessed timestamp.
- [ ] `CADET_TOKEN_SAVER_MEMORY` override works.
- [ ] Tests in `test/memory.test.ts`.
