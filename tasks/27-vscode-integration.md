# Task 27 — VS Code Integration (MCP registration + chat customization)

**Risk rationale:** Low — config/steering only; makes the MCP server actually usable from VS Code.

**Status:** Not started
**Phase:** Phase 13
**Source:** `docs/plans/initial_design.md` — §16 Integration & interception (VS Code)

## Objective

Make the MCP server one click away from VS Code: register it and steer the agent to use it.

## Details

- Add `.vscode/mcp.json` that registers `cadet-token-saver mcp` so Copilot Chat auto-discovers it.
- Add a chat customization (`.prompt.md` / `AGENTS.md`) that tells the agent: before reading a large file call `optimize_context`; before dumping search results use `find_relevant_symbols`; prefer `compress_command_output` for noisy commands.
- Document the `wrap` command for VS Code tasks / terminal profiles.
- Keep everything local; no cloud.

## Acceptance Criteria

- [ ] `.vscode/mcp.json` registers the server and it appears in Copilot Chat.
- [ ] Chat customization steers the agent to use the tools.
- [ ] Documented steps to use `wrap` from a VS Code task.
