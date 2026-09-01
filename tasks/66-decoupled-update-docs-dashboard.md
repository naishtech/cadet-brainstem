# 66 — Decoupled: update docs + dashboard

**Status:** Done

Part of the decoupled-architecture plan (`docs/plans/decoupled-architecture.md`).
After tasks 62–65, reflect the new shape: brainstem measures (LeanCTX only) and
steers/orchestrates, but no longer proxies Serena or RTK.

## Change matrix

### 1. Docs
- `README.md` — describe the standalone core (`steering`, `procedures`,
  `optimize_context`), remove `serena_call` / `leanctx_call` /
  `compress_command_output` from the tool list.
- `docs/requirements.md`, `docs/integration-vscode.md` — update exposed-tool and
  architecture descriptions.
- `CHANGELOG.md` — entry for the decoupling (LeanCTX-only measurement; Serena &
  RTK proxies removed).

### 2. Dashboard
- Any remaining dashboard copy referencing serena/rtk savings updated to
  LeanCTX-only.

### 3. Agent instructions
- `AGENTS.md` — if it references the proxy tools, update to the new surface.

## Acceptance criteria
- Docs and dashboard describe brainstem as steering + procedures + LeanCTX
  measurement, with no serena/rtk proxy references.
