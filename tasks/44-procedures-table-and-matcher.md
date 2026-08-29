# 46 — `procedures` table + local-LLM procedure matcher

**Status:** Planned (not yet implemented)
**Source:** Real historical coding-conversation archive / new capability — local-LLM procedure matcher.

## Goal

Add a new capability: a local-LLM-driven **procedure matcher** that recognizes
routine, previously-seen tasks (e.g. "stage changes, commit, open PR") and
either executes them autonomously (low-risk only) or hands off to the cloud
LLM/human with a suggested procedure attached.

## Naming rule (critical)

There is an existing memory service used by the cloud LLM for recalling
facts/context (advisory, non-authoritative). This capability is conceptually
different: it stores **repeatable action procedures with execution track
records**, not recalled facts. **Do not name anything "memory".** Use
"procedure" / "procedures" throughout — table name, module name, variable
names, MCP tool names.

## Step 1 — Confirm database reuse (verified)

Findings from examining the existing memory service (`src/memory/`):
- **DB engine:** `node:sqlite` (`DatabaseSync`) — Node's built-in SQLite. No
  external DB service.
- **Connection:** `MemoryStore` opens a single local file
  `~/.cadet-brainstem/memory.db` (env override `CADET_BRAINSTEM_MEMORY`). It
  runs **in the same process** as the MCP server / CLI, so the same process
  already has (or can trivially open) a connection to the same database.
  A project-scoped variant (`src/memory/project.ts`) writes to
  `<projectRoot>/.cadet/brainstem/memory.db`; the global `memory.db` is the
  shared store.
- **Schema management:** `CREATE TABLE IF NOT EXISTS` + a `migrate()` that
  reads `PRAGMA table_info(<table>)` and runs `ALTER TABLE ADD COLUMN` for new
  columns — existing databases upgrade in place. Adding a new table is
  straightforward.
- **Verdict:** reuse the same database by adding a `procedures` table. No
  structural reason for a separate service/DB. Do not create a new one.

## Deliverables

### 1. `procedures` table schema — `src/procedure/schema.ts` (+ migration)

Add a `procedures` table to the existing database via the `CREATE TABLE IF NOT
EXISTS` + `migrate()` pattern (same as `src/memory/store.ts`). Columns:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | generated, e.g. UUID |
| `trigger_pattern` | TEXT NOT NULL | short human-readable description, e.g. "stage all changes, commit, open PR" |
| `keywords` | TEXT NOT NULL | JSON array of match terms, e.g. `["commit","pr","push","stage"]` |
| `steps` | TEXT NOT NULL | JSON ordered list of commands/actions; support simple templating for variables (e.g. commit messages) |
| `risk_tier` | TEXT NOT NULL | enum `auto_execute` \| `requires_review` \| `never_auto` |
| `success_count` | INTEGER NOT NULL DEFAULT 0 | |
| `failure_count` | INTEGER NOT NULL DEFAULT 0 | |
| `last_used_at` | TEXT | nullable timestamp |
| `last_outcome` | TEXT | nullable enum `success` \| `failure` |
| `source` | TEXT NOT NULL | enum `manually_seeded` \| `learned_from_usage` |
| `created_at` | TEXT NOT NULL | |
| `updated_at` | TEXT NOT NULL | |

Indexes: follow the existing convention for JSON/array columns (the memory
service stores `tags` as a JSON array in a TEXT column; match how it is indexed
there). Add lookup support for keyword/trigger matching.

### 2. `ProcedureStore` — `src/procedure/store.ts`

Class `ProcedureStore` (same shape as `MemoryStore`, substituting "Procedure"
for "Memory"), same DB connection pattern. Methods:

- `findMatches(entities: string[], task: string): Procedure[]` — returns
  procedures whose keywords overlap the given entities, ranked by overlap
  quality and track record
  (`success_count / (success_count + failure_count)`). Unproven procedures (0
  total runs) rank below proven ones but are still returned as candidates.
- `recordOutcome(procedureId, outcome: "success" | "failure")` — updates
  `success_count` / `failure_count` / `last_used_at` / `last_outcome`.
- `seedProcedure(procedure)` — inserts a manually-authored procedure with
  `source: "manually_seeded"`.
- `logObservedUsage(procedure)` — inserts a procedure discovered from real
  usage with `source: "learned_from_usage"`, starting at
  `risk_tier: "requires_review"` regardless of what tier a similar manual entry
  might have.

Export from `src/procedure/index.ts`. Do **not** export through the memory
module.

### 3. Seed script — `scripts/seed-procedures.ts`

3–5 starting procedures at conservative risk tiers, using **real tool names
registered in this system** (verified registered MCP tools: `classify`,
`optimize_context`, `find_relevant_symbols`, `serena_call`, `serena_list_tools`,
`leanctx_call`, `leanctx_list_tools`, `compress_command_output`,
`chat_memory_store`, `activate_project`, `assess_context`; git is available via
the terminal). Do not invent tool names. Suggested seed set:

- Read-only: "check git status/diff" → `risk_tier: auto_execute`.
- Read-only: "run test suite and report results" → `risk_tier: auto_execute`.
- Reversible local: "run formatter" → `risk_tier: requires_review` (promote
  later once the track record justifies it).
- Requires review: "stage, commit, open PR" → `risk_tier: requires_review`
  (likely should stay non-auto because PR creation leaves the local machine —
  **flag this tier for the user to confirm rather than deciding**).

## Review checkpoints (do not skip)

- **Step 1 report:** confirm DB reuse finding with the user before building.
- **Seed risk_tier confirmation:** do **not** finalize/write seed data until the
  user confirms the `risk_tier` assignments, especially anything marked
  `requires_review`.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `procedures` table is created in the existing DB via the `migrate()` pattern;
  existing memory data is untouched.
- `ProcedureStore` implements `findMatches`, `recordOutcome`, `seedProcedure`,
  `logObservedUsage` with correct semantics (unproven procedures still returned,
  `logObservedUsage` forced to `requires_review`).
- Seed script uses only real registered tool names and starts conservative.
- No "memory" naming leak into the procedures module; seed data not written
  until risk tiers are user-confirmed.
