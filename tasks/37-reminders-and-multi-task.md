# 37 — Reminders (replace guidance), multi-task classification & LeanCTX adoption

**Status:** Implemented — reminders + subtasks + LeanCTX-adoption telemetry
landed (uncommitted at time of writing). See checklist.

Goal
----
Replace the classifier's one-line `guidance` with a generic, tool-anchored
`reminders` list the cloud LLM actually honors; teach the local classifier to
recognize **multi-task** requests (e.g. "check in + push + start next coding
task") and emit per-subtask tool reminders; and fix why the **LeanCTX**
adapter is rarely used.

Background / investigation findings
-----------------------------------
Investigation (subagent + code reads) produced these root causes:

1. **`optimize_context` is opt-in only, not orchestrated.**
   `src/mcp/server.ts` exposes `optimize_context` as a tool the cloud LLM must
   choose to call (`handleToolCall` → `optimizeContextTool`, ~L1311; `classify`
   only returns advisory JSON ~L450–486). Nothing chains `classify → optimize`.
   If the agent ignores the advisory, LeanCTX never runs.

2. **Recommendation is weak/secondary.** The classifier prompt tells the model
   to use the *smallest* tool set and to prefer `find_relevant_symbols` first;
   `optimize_context` is framed as "instead of reading a large file raw" and is
   usually a 2nd-choice recommendation from a tiny local model (`qwen3:1.7b`).

3. **No git/PR task type + a self-invalidating example.** `taskTypeSchema`
   (`src/classifier/schema.ts` L5–20) has 13 values, no `git`. Git-ish requests
   fall into `review`/`planning`/`configuration`. Worse, the prompt example
   (`classifier-prompt.mustache` ~L96) emits `"tool_plan":{"use":["git"]}` — but
   `git` is not in `TOOL_NAMES`, so `sanitizeToolPlan` **drops it** → empty
   `use` → no `optimize_context` suggestion for exactly the multi-step git
   flows the user cares about.

4. **Policy is not the blocker.** Every task type maps to a `leanctx_mode`
   (`src/policy/schema.ts` `defaultPolicies`); `refineStrategy` only narrows it.
   The mode is computed but applied only if the agent calls `optimize_context`.

5. **Metrics record only on invocation.** All tools are recorded at call time
   (`tool:'leanctx'` at `src/mcp/server.ts` L363), so low invocation → near-zero
   counts; there is no "recommended vs invoked" telemetry to measure adoption.

What to implement
-----------------

### 1. Replace `guidance` with structured `reminders`
- Add `reminders: Array<{ tool: string; message: string }>` to the
  `Classification` schema (`src/classifier/schema.ts`). `tool` is a **hint
  label** (advisory, not strictly validated against `TOOL_NAMES` — may be
  `rtk`, `leanctx`, `serena`, `git`, `shell`, `memory`, …). `message` is one
  short concrete directive.
- Keep `guidance` as a **deprecated alias**: still parsed/serialized, derived
  from `reminders` (or the first reminder) for a transition period so existing
  consumers don't break. Mark it deprecated in JSDoc.
- Update sanitizers: `sanitizeReminders` (keep non-empty `{tool,message}`,
  drop invalid entries, cap counts/lengths); keep `sanitizeGuidance`.
- Update MCP (`src/mcp/server.ts`): add `compileReminders()`; return `reminders`
  from `classify`/`optimize_context`; keep `guidance` (compiled from reminders)
  as an alias. `compileGuidance` can reduce to `reminders[0].message` fallback.

### 2. Multi-task classification
- Add optional `subtasks: TaskType[]` to `Classification`. The primary `task`
  stays the *first* task; `subtasks` lists the additional distinct task types
  detected (deduplicated, sanitized against `taskTypeSchema`).
- Update the classifier prompt (`classifier-prompt.mustache` + default template
  in `src/classifier/ollama.ts`) to detect multiple tasks and emit `subtasks`.
- Add **reminder templates keyed by task/tool** so the local model emits
  concrete, reusable reminders instead of prose guidance, e.g.:
  - git/ops subtask → `{tool:'rtk', message:'Use RTK (compress_command_output) for git status/log/diff output.'}`
  - git/ops subtask → `{tool:'shell', message:'Use LeanCTX to expand shell/command output before triage.'}`
  - coding subtask → `{tool:'find_relevant_symbols', message:'Locate the relevant symbols first.'}`
  - coding subtask → `{tool:'optimize_context', message:'Expand/compress the relevant file or shell context with LeanCTX.'}`
  - search subtask → `{tool:'serena', message:'Semantic search for references first.'}`
- Reminders must be **generic and task-agnostic** (not specific to a repo), so
  they hold across sessions and repos.

### 3. Improve LeanCTX adoption
- **Fix the invalid example**: change the PR example in
  `classifier-prompt.mustache` so it emits only valid `TOOL_NAMES` (e.g.
  `compress_command_output` + `optimize_context`), never `git`.
- **Strengthen the tool description** for `optimize_context`
  (`src/mcp/server.ts` TOOL_DEFS ~L1067): make it cover *both* compressing a
  large file *and* expanding/triaging shell output, and lower friction (make
  `target` optional when the intent is triage/expansion).
- **Re-rank the recommendation**: adjust prompt guidance so `optimize_context`
  is not always second behind `find_relevant_symbols` — recommend it when
  context/expansion is needed, especially for git/multi-step flows.
- **Add adoption telemetry**: record both *recommended* (from `tool_plan` /
  `reminders`) and *invoked* per tool, so `stats` can show
  "recommended vs used" and we can verify the fix (this is how we prove the
  LeanCTX adoption problem is solved). Extend the metrics schema/`stats`
  output with a `recommended` counter.

### 4. Tests
- Schema tests: `reminders` sanitization, `subtasks` sanitization/dedup,
  `guidance` alias derivation.
- Classifier tests: prompt teaches `reminders`/`subtasks`; a multi-task request
  yields `subtasks` + per-subtask reminders.
- MCP tests: `classify`/`optimize_context` return `reminders` and `subtasks`;
  `guidance` alias still present.
- Smoke (`scripts/mcp-classify-e2e.ts`): assert `reminders` presence.

Files likely to change
----------------------
- `src/classifier/schema.ts` — `Reminder`/`subtasks` types, sanitizers, alias.
- `src/classifier/ollama.ts` + `classifier-prompt.mustache` — teach reminders,
  subtasks, fix invalid example, re-rank LeanCTX recommendation.
- `src/classifier/degradation.ts` — conservative default reminders/subtasks.
- `src/mcp/server.ts` — compile + return `reminders`/`subtasks`; better
  `optimize_context` description; adoption telemetry hook.
- `src/metrics/*` + `src/cli/commands/stats.ts` — recommended-vs-invoked
  counters.
- `test/*.test.ts`, `scripts/mcp-classify-e2e.ts`.
- `CHANGELOG.md`, `docs/initial_design.md`, `AGENTS.md` (steering mentions
  `reminders` instead of `guidance`).

Acceptance criteria
-------------------
- `classify`/`optimize_context` responses include a non-empty `reminders` array
  with `{tool, message}` entries.
- `guidance` is still present as a deprecated alias (non-empty).
- A multi-task request (e.g. git check-in + push + start coding) returns
  `subtasks` with 2+ task types and reminders covering RTK-for-git and
  LeanCTX-for-shell-output.
- No prompt example emits an invalid tool name (no `git` in `tool_plan.use`).
- `optimize_context` tool description invites both file compression and shell
  output expansion/triage.
- New adoption telemetry shows recommended vs invoked per tool; `stats` prints
  it.
- Unit + smoke tests updated; full suite green.

Implementation notes
--------------------
- Keep `reminders`/`subtasks` **lenient** (`z.unknown().optional()` +
  sanitizers) so an imperfect local model output never throws away a good
  classification (pattern already used for `tool_plan`/`evidence_plan`).
- Reminders are advisory, never authoritative; `memory_policy` wording and
  `AGENTS.md` should present them as strong hints the orchestrator may follow.
- `guidance` removal is a two-step: introduce `reminders` + keep alias now;
  remove `guidance` in a later release once consumers migrate.

Follow-up
---------
- After implementation, run a real MCP session and check `stats`
  recommended-vs-invoked to confirm LeanCTX adoption improved.
- Consider adding a `git` task type or a dedicated `ops`/`vcs` category if
  multi-step git flows remain common.

Checklist
---------
- [x] Add `reminders` + `subtasks` schema types and sanitizers
- [x] Keep `guidance` as deprecated alias (derived from first reminder)
- [x] Update classifier prompt/examples (fix `git`, teach reminders/subtasks)
- [x] Return `reminders`/`subtasks` from MCP `classify`/`optimize_context`
- [x] Improve `optimize_context` description (file compression + shell triage)
- [x] Add recommended-vs-invoked adoption telemetry + `stats` output
- [x] Update tests + smoke script
- [x] Update docs, AGENTS.md steering, CHANGELOG

Notes: the `git` example fix and "offer both" shell routing were already done
in Task 38 Part B. Adoption telemetry adds a `recommended_tools` column
(migrated in place) recorded on classify events and surfaced in `stats`
"Recommended vs invoked".
