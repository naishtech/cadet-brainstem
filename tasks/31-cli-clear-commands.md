# Task 31 — CLI: stats clear + memory clear (with confirmation)

**Risk rationale:** Destructive commands are a safety surface — a mis-typed
clear wipes the user's metrics/memory, so confirmation (interactive, defaulting
to "no" when non-interactive) is mandatory.

**Status:** Implemented on branch `task/29-31-chat-memory-store` (pending review/commit)
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §1 CLI, §8 Metrics, §17 Chat memory store

## Objective

Add two destructive-but-safe CLI subcommands:

- `cadet-token-saver stats clear` — empty the metrics database.
- `cadet-token-saver memory clear` — empty the memory database.

Both require an explicit confirmation prompt before doing anything, and both
default to **no** (no-op) when the terminal is not interactive.

## Details

- `stats clear`:
  - Subcommand of the existing `stats` command (`runStats`/`statsCommand`),
    e.g. `cadet-token-saver stats clear`.
  - Confirmation flow (reuse the TTY-aware `askYesNo()` pattern from `init` —
    non-TTY → "no"):
    - print what will be deleted (the metrics DB path + event count).
    - "Clear ALL metrics? This cannot be undone. [y/N]".
  - On confirm: wipe the `optimisation_events` table (not necessarily delete
    the file — keep the DB file/table intact, truncate rows) and report the
    count cleared.
- `memory clear`:
  - New `memory` CLI command with a `clear` subcommand (the same command that
    could later gain `list`/`show` etc.).
  - Same confirmation pattern: print the memory DB path + memory count, ask
    `[y/N]`, default no when non-interactive.
  - On confirm: truncate the `memories` table and report the count cleared.
- Add a `MemoryStore.clear()` method (and `MetricsStore.clear()`) that empties
  the relevant table and returns the number of rows removed — the CLI calls
  these after confirmation.
- Register `memory` in the `COMMANDS` registry (`src/cli/commands.ts`) and the
  `stats` command handles its `clear` subcommand.
- Read-only guard: `doctor` must never trigger a clear; clearing never touches
  config or other data.

## Acceptance Criteria

- [x] `cadet-token-saver stats clear` prompts and (on "y") empties metrics.
- [x] `cadet-token-saver memory clear` prompts and (on "y") empties memory.
- [x] Non-interactive runs default to "no" and print a message (no data loss).
- [x] Typing "n" / anything but confirm leaves data intact.
- [x] Reports how many rows were cleared.
- [x] `MetricsStore.clear()` / `MemoryStore.clear()` return the removed count.
- [x] Tests: confirmation flow (mock the prompt), non-interactive default,
      and actual clearing round-trips in `test/stats-command.test.ts` +
      `test/memory.test.ts`.
