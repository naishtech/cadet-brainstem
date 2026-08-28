# 43 — Rename project to `cadet-brainstem`

**Status:** Planned (not yet implemented)

Rename the entire project from **Cadet Token Saver** (`cadet-token-saver`) to
**Cadet Brainstem** (`cadet-brainstem`). This is a mechanical but wide-reaching
rename: the string appears in **73 files** across package metadata, the CLI
binary, config/data paths, env vars, MCP registration, hook config, docs, and
tests.

## Naming convention

| Aspect | Old | New |
| --- | --- | --- |
| npm package name | `cadet-token-saver` | `cadet-brainstem` |
| CLI binary (on PATH) | `cadet-token-saver` | `cadet-brainstem` |
| Display name | `Cadet Token Saver` | `Cadet Brainstem` |
| Config / data dir | `.cadet-token-saver` | `.cadet-brainstem` |
| Project memory dir | `.cadet/token-saver/` | `.cadet/brainstem/` |
| State dir (hooks) | `~/.local/state/cadet-token-saver/hooks` | `~/.local/state/cadet-brainstem/hooks` |
| Env var prefix | `CADET_TOKEN_SAVER_*` | `CADET_BRAINSTEM_*` |
| Hooks filename | `cadet-token-saver.json` | `cadet-brainstem.json` |
| MCP server key | `cadet-token-saver` | `cadet-brainstem` |
| GitHub repo | `naishtech/cadet-token-saver` | `naishtech/cadet-brainstem` |
| Log prefix | `[cadet-token-saver]` | `[cadet-brainstem]` |

**Decision:** use the kebab-case slug `cadet-brainstem` everywhere except
display/description prose, which uses title case **Cadet Brainstem**.

## Change matrix (by area)

### 1. Package identity
- `package.json` — `name`, `description`, `homepage`, `repository.url`, `bin`
  key, `postinstall` message.
- `package-lock.json` — `name` and nested `packages[""].name`.
- `publish-npm.ps1` — header comment, package name references.
- Rename `bin/cadet-token-saver.cjs` → `bin/cadet-brainstem.cjs`.

### 2. CLI binary + usage strings
- `src/cli/help.ts` — program name + tagline.
- `src/cli/commands.ts` — "unknown command" error prefix.
- `src/cli/commands/*.ts` — every `usage:` / `Run:` / hook-command string:
  `config.ts`, `dashboard.ts`, `doctor.ts`, `mcp.ts`, `memory.ts`, `init.ts`,
  `stats.ts`, `telemetry.ts`, `wrap.ts`, `hooks.ts`, `hook-lifecycle.ts`,
  `hook-remind.ts`, `hook-redirect.ts`.

### 3. Log prefix `[cadet-token-saver]`
- All `console.*` / `log()` call sites in `src/` (classifier, cli, mcp server,
  integrations). Replace with `[cadet-brainstem]`.

### 4. Config / data / state paths
- `src/config/config.ts` — `CONFIG_DIR = '.cadet-brainstem'`.
- `src/metrics/store.ts` — `DEFAULT_METRICS_DIR = '.cadet-brainstem'`.
- `src/memory/store.ts` — `DEFAULT_MEMORY_DIR = '.cadet-brainstem'`.
- `src/memory/project.ts` — `join(projectRoot, '.cadet', 'brainstem', 'memory.db')`.
- `src/cli/commands/hook-lifecycle.ts`, `hook-remind.ts` — state dir under
  `.local/state/cadet-brainstem/hooks`.
- `scripts/classify-smoke.ts` — default config path comment.

### 5. Env vars
- `CADET_TOKEN_SAVER_CONFIG` → `CADET_BRAINSTEM_CONFIG`.
- `CADET_TOKEN_SAVER_METRICS` → `CADET_BRAINSTEM_METRICS`.
- `LEAN_CTX_AGENT_ID=cadet-token-saver` → `...=cadet-brainstem`
  (`src/integrations/leanctx/` + `tasks/38-*`).

### 6. MCP + VS Code registration
- `.vscode/mcp.json` — server key `cadet-brainstem`.
- `.vscode/tasks.json` — task command strings (`cadet-brainstem init`, etc.).
- `src/integrations/serena/adapter.ts` — MCP `Client({ name: 'cadet-brainstem' })`.
- `src/mcp/server.ts` — log prefix + tool metadata strings.

### 7. Hooks config
- `src/cli/commands/hooks.ts` — `DEFAULT_HOOKS_FILENAME = 'cadet-brainstem.json'`,
  all `cadet-token-saver hook-*` command strings.

### 8. Docs, README, changelog, agent instructions
- `README.md` — title, description, install (`npm i -g cadet-brainstem`), all
  `cadet-token-saver ...` command examples.
- `docs/requirements.md`, `docs/integration-vscode.md`, `docs/plans/*`.
- `CHANGELOG.md` — entry for this rename (keep historical entries as-is).
- `AGENTS.md` — title + MCP command references.
- `.gitignore` — section comment.

### 9. Tests
- Update assertions that hardcode the old name / paths / hooks filename:
  `test/cli.test.ts`, `doctor-command.test.ts`, `hooks-command.test.ts`,
  `mcp-server.test.ts`, `memory.test.ts`, `metrics.test.ts`,
  `vscode-integration.test.ts`, and any others that reference
  `cadet-token-saver`.

### 10. Task history (leave historical, add forward refs)
- Do **not** rewrite existing `tasks/*.md` bodies (they are historical records
  of the old name). Add a short header note to the plan that later tasks use
  `cadet-brainstem`.

## Ordered steps

1. **Package + bin rename** — edit `package.json`, `package-lock.json`,
   `publish-npm.ps1`, rename `bin/` file. Update `bin` map.
2. **Source string sweep** — update `src/` for CLI usage strings, log prefix,
   config/data/state dirs, env vars, MCP/serena client name, hooks filename.
3. **Workspace metadata** — `.vscode/mcp.json`, `.vscode/tasks.json`,
   `.gitignore`.
4. **Docs + README + CHANGELOG + AGENTS.md**.
5. **Tests** — update assertions; keep behavior identical.
6. **Reinstall symlink/binary** — refresh any globally linked binary name so
   `cadet-brainstem` is on PATH (and note old `cadet-token-saver` no longer
   resolves).
7. **Verify + validate** — `npm run build`, `npm run typecheck`, `npm run lint`,
   `npm test`. Grep for leftover `cadet-token-saver` / `CADET_TOKEN_SAVER` (case
   insensitive) — expect zero matches except intentional historical refs.

> **Note:** No data migration needed. The project has no active users, so old
> dirs (`~/.cadet-token-saver/`, `.cadet/token-saver/`) and legacy
> `CADET_TOKEN_SAVER_*` env vars are simply dropped.

## Validation

- Build, typecheck, lint, and full test suite green.
- `grep -ri "cadet-token-saver\|CADET_TOKEN_SAVER\|token-saver\|Token Saver"`
  returns **zero** matches (excluding intentional historical refs in
  `CHANGELOG.md` and `tasks/`).
- `npx cadet-brainstem doctor` runs and reports the new name.
- `.vscode/mcp.json` server resolves as `cadet-brainstem` in Copilot Chat.
