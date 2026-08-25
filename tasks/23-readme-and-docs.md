# Task 23 — README & Documentation

**Risk rationale:** Deliverable — documents architecture, config, safety principles and the deliberate non-goals.

**Status:** Not started
**Phase:** Final deliverables
**Source:** `docs/plans/initial_design.md` — §17 Development approach (final docs)

## Objective

Write the user-facing and architecture documentation required for a usable npm package.

## Details

Provide:

- README (installation, quick start with `npx cadet-token-saver init`, command reference)
- Installation instructions
- Architecture documentation
- Configuration reference
- Security/privacy documentation
- Example policies

The docs must document the ten safety principles from §14 in full:

1. Never silently discard information that cannot be recovered.
2. Full/raw output must remain accessible.
3. Explicit user requests for exact/raw/full context override optimisation.
4. The LLM classifier must never directly execute commands.
5. Optimisation failures must fall back to the original behaviour.
6. Never require cloud connectivity for core functionality.
7. Never collect source code or prompts for telemetry.
8. Clearly distinguish measured values from estimates.
9. Never claim that compression preserves correctness unless tested.
10. Every optimisation should be reversible/debuggable.

The docs must also clearly state:

- Everything is orchestration/measurement; RTK, Serena, LeanCTX remain the underlying tools.
- MVP explicitly does NOT build: cloud MCP server, payments, State Tree, auto-summarisation, custom compression/search/intelligence, remote classifier, model selection, enterprise/team features, complicated UI, billing integration.
- Reference the §16 success criteria so the docs map features to the measurable goals.

## Acceptance Criteria

- [ ] README covers install, quick start, and all commands.
- [ ] Architecture doc describes the modular layout and adapter pattern.
- [ ] Configuration reference matches the Task 02 schema and defaults.
- [ ] Security/privacy doc covers telemetry guarantees and offline operation.
- [ ] Example policies included.
- [ ] Docs state clearly what the MVP deliberately does not build.
