# 44 — `procedures` table + local-LLM procedure matcher

**Status:** Implemented (read-only scope; pending review/commit)
**Source:** Real historical coding-conversation archive / new capability — local-LLM procedure matcher.

## Goal

Add a capability where the **local LLM executes routine tasks on behalf of the
cloud LLM**. The `classify` response returns a **list of matched procedures**
that the local LLM can execute; the cloud LLM hands off to those procedures
instead of doing the work itself. Procedures match the **local services the
local LLM has** (LeanCTX, Serena, RTK). Scope is **read-only** for now.

## Architecture (revised)

1. Cloud LLM calls `classify(request)`.
2. The classifier extracts `entities` and runs the procedure matcher
   (`ProcedureStore.findMatches`).
3. The `classify` response includes a **`procedures`** field — matched
   procedures the local LLM can execute.
4. The cloud LLM **hands off** to the local LLM, which executes the procedures.
5. Each `Procedure.step` maps to a **local service/capability** invocation, not
   a generic shell command.

Capability model — each step references one of the local services:

```ts
interface ProcedureStep {
  service: 'leanctx' | 'serena' | 'rtk';
  tool: string;   // e.g. ctx_read, find_symbol, compress_command_output
  args?: Record<string, unknown>; // resolved at execution time
}
```

All local services are read-only / context-reduction:

- `leanctx` → `leanctx_call` (LeanCTX): read/compile/compress context.
- `serena` → `serena_call` (Serena): symbol search / referencing / rename.
- `rtk` → `compress_command_output` (RTK): compress noisy command output.

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
| `keywords` | TEXT NOT NULL | JSON array of match terms, e.g. `["compress","context","ctx"]` |
| `steps` | TEXT NOT NULL | JSON ordered list of `ProcedureStep` capability invocations (`{service, tool, args?}`); no arbitrary shell commands |
| `risk_tier` | TEXT NOT NULL | enum `auto_execute` \| `requires_review` \| `never_auto` — read-only tasks default to `auto_execute` |
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

### 3. Wire procedures into the `classify` response — `src/mcp/server.ts`

In the `classify` handler, after classification, run
`ProcedureStore.findMatches(classification.entities, task)` and include the
matched procedures in the response as a `procedures` field (alongside
`tool_plan` / `entities` / `strategy`). This is the handoff list the cloud LLM
returns to the local LLM for execution.

### 4. Seed script — `scripts/seed-procedures.ts`

3–5 **read-only** starting procedures at conservative risk tiers, using **real
local services** (LeanCTX `leanctx_call`, Serena `serena_call`, RTK
`compress_command_output`). Do not invent tool names. Suggested seed set (all
read-only, `risk_tier: auto_execute` unless noted):

- "Gather and compress relevant context" → `[leanctx_call(ctx_read)]`
- "Find symbols for a change" → `[serena_call(find_symbol)]`
- "Compress a command's output" → `[compress_command_output(...)]`
- "Summarize project structure" → `[leanctx_call(ctx_explore)]`

No git commit / PR / formatter entries — those are write actions the local
read-only services cannot execute. `risk_tier` for all read-only steps is
`auto_execute`; anything later discovered that touches state defaults to
`requires_review`.

## Review checkpoints (do not skip)

- **Step 1 report:** confirm DB reuse finding with the user before building.
- **Seed risk_tier confirmation:** read-only seed entries default to
  `auto_execute`; do **not** add any non-read-only (write/state-changing) step
  without the user confirming its `risk_tier`.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `procedures` table is created in the existing DB via the `migrate()` pattern;
  existing memory data is untouched.
- `ProcedureStore` implements `findMatches`, `recordOutcome`, `seedProcedure`,
  `logObservedUsage` with correct semantics (unproven procedures still returned,
  `logObservedUsage` forced to `requires_review`).
- `Procedure.steps` use only real local services (`leanctx`, `serena`, `rtk`);
  no arbitrary shell-command or write-action steps.
- The `classify` response includes a `procedures` handoff list.
- Seed script is read-only and starts conservative; no "memory" naming leak;
  no non-read-only seed data without user confirmation.
