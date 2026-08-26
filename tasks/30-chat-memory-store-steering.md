# Task 30 — Chat Memory Store: steering + docs + release

**Risk rationale:** Adoption — the agent must actually use memory (steering +
response policy) and the docs must explain when/why to store, so the feature
saves tokens in practice rather than sitting unused.

**Status:** Not started
**Phase:** Phase 12
**Source:** `docs/plans/initial_design.md` — §17 Chat memory store

## Objective

Wire the memory feature into agent steering, docs, stats and the release so it
is discoverable and actually used.

## Details

- `AGENTS.md`:
  - Add a "Memory" note telling the agent to check `chat_memory_store` before
    starting work and to store facts that are expensive to rediscover
    (decisions, constraints, verified commands, gotchas); never store secrets.
  - Mention the `memory_policy` returned by `classify`.
- `init` "tell your agent" snippet: mention `chat_memory_store` + the
  `memory_policy`.
- Docs: `README.md` + `docs/integration-vscode.md` — document the
  `chat_memory_store` tool, the `memory_policy`, and the
  "expensive to rediscover" guidance.
- `stats`: add `memory` to the "Local tool calls" tool list so memory
  operations are visible.
- Version bump + `CHANGELOG.md` entry.

## Acceptance Criteria

- [ ] `AGENTS.md` + `init` snippet reference `chat_memory_store` / `memory_policy`.
- [ ] README + integration docs cover the memory feature and the
      store-only-expensive-facts guidance.
- [ ] `stats` "Local tool calls" includes `memory`.
- [ ] Version bumped + CHANGELOG updated.
- [ ] Full validation: build, typecheck, lint, tests all green.
