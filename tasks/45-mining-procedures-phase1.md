# 45 — Mine procedures from conversation history — Phase 1: inventory, parse, scrub, curate (agent), stage for review

**Status:** Planned (not yet implemented)
**Phase:** Two-phase effort (Phase 1 = this task; Phase 2 = task 46)
**Source:** Real historical coding-conversation archive, mined as seed data for the `procedures` table.

## Goal

Turn a large archive of real historical coding conversations (VS Code
workspace storage under
`C:\Users\User\AppData\Roaming\Code\User\workspaceStorage`) into a **staged,
human-reviewed candidate set** for the `procedures` table. This task is Phase 1
only: it inventories, parses, scrubs, and extracts candidate procedures, then
**stops for review**. Nothing is written into the live `procedures` table here.

## Scope & hard constraints

- This task is **entirely about the `procedures` table and its candidates**.
  It must **NOT** touch the existing memory service or its data
  (`src/memory/store.ts`, `memory.db`, the `memories` table, the chat-memory
  store/MCP endpoint). Use a **separate** mining database and module.
- Mined data goes through a **human review checkpoint before promotion**.
  Phase 1 never auto-promotes — it stages candidates for review only.
- The source format is **to be confirmed, not assumed** (Step 1.1). Do not
  start extraction until the format has been verified and reported.

## Why

Hand-seeded `procedures` entries are trusted, but there is a large archive of
real conversations that encodes repeatable, mechanical tasks ("stage and
commit", "run tests and fix a specific failure", "scaffold a component from an
existing pattern"). Mining them yields a much richer seed set than hand-seeding
alone. But mined data is untrusted until reviewed, so it must be staged,
scrubbed for secrets, and human-approved before it can reach the live table.

## Prerequisites / dependencies

- The live `procedures` table and its `ProcedureStore` (with `findMatches`)
  are referenced as "built earlier". **They do not currently exist in
  `src/`** (verified: no `procedures` / `ProcedureStore` / `findMatches`
  symbols). They are a **hard prerequisite for Phase 2 (task 46)**, not for
  this Phase 1 task. Confirm they exist before starting task 46.
- No secrets-scanning dependency is present in `package.json` (deps are only
  `@modelcontextprotocol/sdk`, `mustache`, `yaml`, `zod`). Step 1.3 must check
  for an existing scanner before writing regex-based redaction.

## Deliverables

### 1. Mining module — `src/mine/`

New module mirroring the `src/memory/` layout. Owns a **separate** SQLite
database (default `~/.cadet-brainstem/mine.db`, env override
`CADET_BRAINSTEM_MINE`), using the existing `node:sqlite` (`DatabaseSync`) +
`CREATE TABLE IF NOT EXISTS` + `migrate()` pattern from `MetricsStore` /
`MemoryStore`. It must never open or write to `memory.db`.

Tables (all in `mine.db`):
- `procedure_candidates_raw` — normalized intermediate records from Step 1.2.
- `procedure_candidates_review` — scrubbed, extraction results staged for
  review (Step 1.4).

Files (suggested):
- `src/mine/store.ts` — `MineStore` (raw + review tables, CRUD + count +
  provenance fields).
- `src/mine/inventory.ts` — Step 1.1 source scan.
- `src/mine/parse.ts` — Step 1.2 conversation → normalized intermediate format.
- `src/mine/redact.ts` — Step 1.3 secret detection/redaction.
- `src/mine/extract.ts` — Step 1.4 procedure-candidate extraction via the
  local LLM.
- `src/mine/review.ts` — Step 1.5 review-summary report.
- `src/mine/index.ts` — exports.

### 2. Step 1.1 — Inventory the source data (`mine inventory`)

Scan `C:\Users\User\AppData\Roaming\Code\User\workspaceStorage` and report,
without extracting:
- How many workspace folders exist.
- How many `chatSessions/*.jsonl` conversation files exist (the conversations
  are **JSONL**, one file per chat session — NOT stored in `state.vscdb`).
- The **actual** JSONL record format: `kind:0` session metadata (`sessionId`,
  `creationDate`), `kind:1` property patches, `kind:2` message records (`v` is
  either a request array or a session snapshot with a `requests` array).
- A rough count of distinct conversations found and the date range covered
  (from each file's `kind:0` `creationDate`).

The inventory command must stop here and print findings. **Do not proceed to
extraction until the format is confirmed and reported** (the user sanity-checks
before processing everything).

### 3. Step 1.2 — Parse into normalized intermediate format (`mine parse`)

Parse each `chatSessions/*.jsonl` file into:
```json
{
  "source_workspace": "<folder name>",
  "conversation_id": "<sessionId or generated hash>",
  "timestamp": "<when>",
  "messages": [ { "role": "user"|"assistant", "text": "..." } ]
}
```
Extract messages from `kind:2` records: user text from each request's
`message.text`, assistant text from its `response.message`. Write to
`procedure_candidates_raw` (the intermediate store). This is **not** the final
`procedures` table.

### 4. Step 1.3 — Scrub for secrets BEFORE further processing (`mine scrub`)

Run a redaction pass over every extracted message in `procedure_candidates_raw`
**before** any procedure extraction:
- **Check first** for an existing secrets scanner in this repo or its
  dependencies; only if none exists, write regex-based detection from scratch.
- Cover common patterns: AWS access keys, GitHub/other tokens, generic
  `key`/`token`/`secret`/`password`/`api_key` = high-entropy values, connection
  strings, and similar credential shapes.
- Replace detected secrets with a fixed redaction placeholder (e.g.
  `[REDACTED:<type>]`) — do not delete the message.
- **Log how many redactions were made per conversation** for visibility.
- The redacted result is what feeds Step 1.4; do not extract procedures from
  unredacted content.

### 5. Step 1.4 — Curate candidate procedures (agent, NOT the local LLM)

For each scrubbed conversation, decide whether it contains a **repeatable,
mechanical task** (e.g. "stage and commit", "run tests and fix a specific
failure", "scaffold a new component from an existing pattern", or a
**Serena edit** like "replace/delete/insert lines in a file") as opposed to
one-off creative/novel problem-solving.

**The coding agent (not the local LLM) does this curation.** The local LLM is
not used for mining at all — it is reserved for *executing* the curated
candidates in Phase 2 (task 46). This avoids the small local model's weakness
at extraction entirely.

- Per conversation, the agent produces:
```json
{
  "is_procedural": true|false,
  "trigger_pattern": "<short description, if procedural>",
  "keywords": ["<extracted keywords>"],
  "steps": ["<concrete commands/actions taken, if identifiable>"],
  "source_conversation_id": "<link back to Step 1.2 record>",
  "difficulty": "easy|medium|hard"
}
```
- **Store curated candidates in test files** (e.g. `test/candidates/*.json`, one
  file per candidate) so task 46 can run each one as a local-LLM performance
  test. Also write them (procedural ones only) to `procedure_candidates_review`
  — **staged, not live**. Include `source_conversation_id`, `timestamp`, and a
  `difficulty` grade (easy → hard) for the progressive testing in Phase 2.
- Mined candidates are **not limited to read-only** — capture edit-capable
  procedures too. On promotion (task 46) any step that writes defaults to
  `risk_tier: "requires_review"`; nothing auto-executes from mined data.

### 6. Step 1.5 — Produce a review summary (`mine review`)

Output a report:
- Total conversations scanned.
- How many candidates curated (procedural).
- The candidate test files written (easy/medium/hard split).
- A sample of candidates (15–20) for eyeballing.
- Ambiguous cases.

**Stop here and wait for review. Do not auto-promote anything to the live
`procedures` table.** Promotion and the progressive local-LLM tests happen only
in Phase 2 (task 46) after explicit approval.

### 7. CLI wiring

- Add a `cadet-brainstem mine <subcommand>` command family
  (`inventory` / `parse` / `scrub` / `extract` / `review`) in
  `src/cli/commands/`, registered in `src/cli/commands.ts`.
- Update `test/cli.test.ts` command list.
- Tests: `test/mine-store.test.ts`, `test/mine-redact.test.ts`,
  `test/mine-extract.test.ts`, `test/mine-inventory.test.ts`.

## Acceptance

- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- `mine inventory` reports workspace count, confirmed data format, conversation
  count, and date range — and stops (no extraction) until format is confirmed.
- `mine parse` fills `procedure_candidates_raw`; `mine.db` is separate from
  `memory.db` and the memory service is never opened by this module.
- `mine scrub` redacts credential patterns, records per-conversation redaction
  counts, and feeds only scrubbed content to extraction.
- `mine extract` writes only procedural candidates to
  `procedure_candidates_review` with `source_conversation_id` + `timestamp`.
- `mine review` prints totals, a 15–20 item sample, and failures/ambiguous
  cases, then stops with no promotion to the live `procedures` table.
