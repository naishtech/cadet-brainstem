# 38 — LeanCTX MCP proxy, shell-vs-RTK routing & metrics evaluation

**Status:** Implemented (Parts A, B & C — see checklist). LeanCTX MCP proxy
(`leanctx_call` / `leanctx_list_tools`), shell-vs-RTK benchmark + "offer both"
routing, and metrics evaluation all landed in PR #35 / release 0.1.16.

Goal
----
Expose LeanCTX's full MCP tool surface (79 `ctx_*` tools) to the cloud LLM by
proxying them the same way we already proxy Serena, then settle two open
questions with real testing:
1. For command-output compression, should we route to **`ctx_shell` (LeanCTX)**
   or **RTK** (`compress_command_output`)? Working hypothesis: **RTK wins**,
   but we need data.
2. Are **LeanCTX's own metrics** (`ctx_metrics` / `ctx_gain` / `ctx_radar`)
   better than our `MetricsStore`, and does **Serena** expose any token-usage
   metrics worth extracting? (Hypothesis: Serena exposes none.)

Background / investigation findings
-----------------------------------
- `lean-ctx mcp` is a stdio MCP server registering **79 tools** (source:
  `docs/reference/appendix-mcp-tools.md` in the cloned `lean-ctx` repo, and a
  live probe of `lean-ctx 3.9.19`). Tool names are `ctx_*` prefixed → no
  collision with our tool names.
- Our `SerenaAdapter` (`src/integrations/serena/adapter.ts`) is already a full
  MCP proxy: persistent `StdioClientTransport` session, `callTool` (verbatim
  forward) + `listTools`, exposed as `serena_call` / `serena_list_tools`
  (`src/mcp/server.ts` ~L787/L842) with per-call metrics.
- Our `LeanCtxAdapter` (`src/integrations/leanctx/adapter.ts`) is **CLI-only**:
  it runs `lean-ctx read <file> -m <mode>` (single `optimize`). It does not use
  the MCP server, so 78 of the 79 tools are unused today.
- LeanCTX is **cwd-based** (no `activate_project` ceremony like Serena), so the
  proxy is simpler than the Serena one.

What to implement
-----------------

### Part A — LeanCTX MCP proxy (mirror Serena)
- Extend `LeanCtxAdapter` (or add `LeanCtxMcpAdapter`) to spawn `lean-ctx mcp`
  as a persistent stdio MCP client with:
  - `callTool(request: { tool: string; arguments?: Record<string, unknown>; cwd?: string })`
    → forwards verbatim to the `ctx_*` tool, returns the raw result + extracted
    text + degraded flag (reuse the `extractText`/error detection pattern).
  - `listTools()` → returns the exposed `ctx_*` tool names + schemas.
  - Persistent session + reconnect-once-on-failure (mirror `SerenaAdapter`).
- Add MCP tools `leanctx_call` and `leanctx_list_tools` to our server:
  - `leanctx_call`: forward any tool name/arguments to LeanCTX; record a
    metrics row `tool:'leanctx', operation:<forwarded tool>`.
  - `leanctx_list_tools`: discovery for the agent (which `ctx_*` tools exist).
- Register both in `TOOL_DEFS` and `handleToolCall` (mirror `serena_call` /
  `serena_list_tools`).
- Keep the existing `optimize` (policy → `lean-ctx read`) path; the proxy is
  additive. (Follow-up: consider reimplementing `optimize` on top of
  `ctx_read`/`ctx_smart_read` for caching.)

### Part B — Testing: `ctx_shell` vs RTK for command-output compression
Goal: decide which adapter `compress_command_output` should use (or how
reminders/`tool_plan` should route shell-command compression).
- Build a small benchmark harness (script under `scripts/`, e.g.
  `scripts/benchmark-shell-compression.ts`):
  - Representative commands: `git status`, `git log --oneline -20`, `git diff
    --stat`, `npm test` (short), `ls -la` of a big dir, `grep -r` output.
  - Run each through RTK (`RtkAdapter.optimize`) and through LeanCTX
    (`ctx_shell` via the new proxy), with the same raw output.
  - Record per tool: input bytes, output bytes, compression ratio, estimated
    tokens saved, latency, and **fidelity** (does the compressed output keep
    the info needed to answer a follow-up question).
- Decision rule: prefer the tool with the better ratio while preserving
  fidelity. If RTK is clearly better (expected), keep RTK as the default
  `compress_command_output` path and update the classifier prompt/reminders so
  git/ops subtasks recommend RTK (not `ctx_shell`). If LeanCTX wins or is close
  with better fidelity, consider switching or offering both.
- Record results in the task doc and a small `docs/` note so the decision is
  reproducible.

### Part C — Metrics evaluation
- **LeanCTX metrics:** investigate `ctx_metrics`, `ctx_gain`, `ctx_radar`,
  `ctx_cost`, `ctx_analyze`, `ctx_compare` via `leanctx_call`/docs. Determine:
  - Do they give per-tool/per-session token + cost savings that our
    `MetricsStore`/`stats` does not?
  - Could we pull a gain summary from LeanCTX and merge it into `stats`?
  - Decision: integrate (map into `stats`/metrics) vs keep our `MetricsStore`
    authoritative. Lean toward: keep our `MetricsStore` for our own call events,
    optionally surface a LeanCTX "gain" line for context.
- **Serena metrics:** confirm whether Serena exposes any token/usage metrics.
  Expected outcome: **no** — Serena is a code-intelligence MCP server whose
  tools return symbol/reference results, not usage/price data. Our serena
  metrics rows already capture calls/latency/degraded/symbols-found; there is
  nothing more to extract. Document this so we stop looking.
- Update `stats` output only if a clear win is found.

Files likely to change
----------------------
- `src/integrations/leanctx/adapter.ts` (or new
  `src/integrations/leanctx/mcp-adapter.ts`) — MCP session + callTool/listTools.
- `src/integrations/leanctx/index.ts` — exports.
- `src/mcp/server.ts` — `McpDeps.leanctx` extends to include callTool/listTools;
  add `leanctx_call` / `leanctx_list_tools` handlers + `TOOL_DEFS` +
  `handleToolCall` cases.
- `scripts/benchmark-shell-compression.ts` (new) — Part B harness.
- `src/integrations/rtk/adapter.ts` (maybe) — expose optimize for reuse in bench.
- `src/cli/commands/stats.ts` + `src/metrics/*` (only if Part C integration wins).
- `src/classifier/classifier-prompt.mustache` / `src/classifier/schema.ts`
  (`TOOL_NAMES`, reminders) — route shell compression to RTK (or ctx_shell)
  based on Part B outcome.
- `test/*.test.ts`, `scripts/mcp-classify-e2e.ts`, `CHANGELOG.md`, docs.

Acceptance criteria
-------------------
- `leanctx_call` and `leanctx_list_tools` work end-to-end against the real
  `lean-ctx mcp` server and expose the `ctx_*` tools to the agent.
- Part B benchmark run: a documented, reproducible result showing the
  compression ratio + fidelity of RTK vs `ctx_shell`; a clear routing decision
  is recorded and applied (reminders/prompt updated accordingly).
- Part C: a documented conclusion on whether to integrate LeanCTX metrics and
  confirmation that Serena exposes no token-usage metrics.
- Unit + integration tests for the new proxy handlers; full suite green.

Implementation notes
--------------------
- Reuse the Serena proxy patterns as much as possible (session reuse, extract
  text, error-as-degraded detection, reconnect-once).
- `ctx_shell` executes shell commands and `ctx_url_read`/`ctx_git_read` are
  network — flag them in docs as powerful/opt-in (same class the agent already
  has, but worth surfacing).
- LeanCTX `power` profile exposes 72 tools by default; the proxy can rely on
  `leanctx_list_tools` + `ctx_discover_tools` for discovery rather than
  hardcoding all 79.
- Do not break the existing `optimize` path or existing tests.

Follow-up
---------
- Consider reimplementing `optimize` via `ctx_read`/`ctx_smart_read`/`ctx_delta`
  (cache-aware reads) once the proxy is live.
- Consider unifying `ctx_knowledge`/`ctx_session` with our `MemoryStore`, and
  `ctx_gain` with our `stats`, in a later task.

Checklist
---------
- [x] Part A: LeanCTX MCP session + `callTool`/`listTools`
- [x] Part A: `leanctx_call` + `leanctx_list_tools` MCP tools + metrics
- [x] Part B: benchmark harness + run RTK vs `ctx_shell`; record decision
- [x] Part B: apply routing decision to prompt/reminders (offer both)
- [x] Part C: evaluate LeanCTX metrics; document Serena has no token metrics
- [x] Tests + smoke updated
- [x] Docs + CHANGELOG updated

### Part B — benchmark result (2026-08-27)
Harness: `npm run benchmark:shell` (`scripts/benchmark-shell-compression.ts`).
Commands: `git status`, `git status --short`, `git log --oneline -20`,
`git diff --stat`, `ls -la`.

| command | raw | RTK | ctx_shell |
|---|---|---|---|
| `git status` | 772B | 422B (55%) 792ms | 345B (45%) 31.7s* |
| `git status --short` | 322B | 321B (100%) 237ms | 258B (80%) 1.1s |
| `git log --oneline -20` | 1094B | 1094B (100%) 224ms | 258B (24%) 1.2s |
| `git diff --stat` | 499B | 498B (100%) 231ms | 258B (52%) 1.1s |
| `ls -la` | 1314B | 409B (31%) 222ms | 158B (12%) 1.1s |
| **avg retained** | — | **77.1% (23% saved)** | **42.4% (58% saved)** |
| avg latency | — | 341ms | 7.3s (1.1s warm; *first call 31.7s cold/graph-build) |

**Decision (data-driven):** LeanCTX `ctx_shell` compresses much better than RTK
on this machine (58% vs 23% tokens saved) — this **contradicts the initial
RTK hypothesis**. Trade-offs: `ctx_shell` is slower per call (~1.1s warm vs
~340ms) with a one-time ~31s cold start (graph build), and its aggressive
filtering (12–24% retention on `git log`/`ls`) may drop detail (fidelity
unmeasured).

**Applied routing (user chose "offer both"):** the classifier prompt now
teaches that shell/CLI-output tasks should offer **both**
`compress_command_output` (RTK — fast, moderate) and `leanctx_call` with
`ctx_shell` (LeanCTX — aggressive compression, slower, may drop detail) so the
downstream agent chooses per the situation. Added `leanctx_call` and
`leanctx_list_tools` to `TOOL_NAMES` so the classifier can recommend them in
`tool_plan.recommended_tools`, with default intents. Updated the PR/git prompt
example to model offering both.

### Part C — metrics evaluation (2026-08-27)
**LeanCTX analytics (complementary, not a replacement).** `ctx_gain` /
`ctx_cost` / `ctx_radar` / `ctx_heatmap` (persisted to `stats.json`,
`cost_attribution.json`, `savings/ledger.jsonl` in `~/.local/share|state/lean-ctx`)
add real value we don't have: USD cost attribution per tool/agent (with model
pricing), an independent hash-chained signed savings ledger (verifiable second
source of truth), heatmap/radar/gain-score context-budget views, and per-mode
compression previews (`ctx_benchmark`/`ctx_compare`/`ctx_analyze`). `ctx_metrics`
is session-scoped only. Attribution to us: set `LEAN_CTX_AGENT_ID=cadet-token-saver`
when spawning `lean-ctx mcp` — **applied** in `LeanCtxAdapter.connect()`.

**Cannot replace our `MetricsStore`** — LeanCTX doesn't track our
`session_id`/`request_id` correlation, policy decisions/`leanctx_mode`,
`latency_ms`, `degraded` (classifier fallback), or orchestration choices; and it
only sees calls that pass through lean-ctx (not RTK/Serena or skipped
compression). Our `OptimisationEvent` rows (session_id, tool, operation,
tokens in/out/saved, ratio, strategy, latency, degraded, request_id,
symbols/files_found) remain the source of truth for our decisions.

**Serena: no token-usage metrics.** Serena is a code-intelligence MCP server;
its tools return symbol/reference/rename results, not usage or price data. Our
serena rows already capture calls/latency/degraded/symbols-found — nothing more
to extract. Stop looking.

**Decision:** keep `MetricsStore` authoritative; optionally surface a
"LeanCTX gain" line in `stats` later by reading `cost_attribution.json` /
`ctx_cost json` (deferred, not required).

**Status:** Part A implemented (pending review/commit). Tests: 225 passing /
21 files. Build, typecheck, lint green. Live-verified against `lean-ctx 3.9.19`:
`listTools` returns the exposed `ctx_*` tools and `ctx_tree`/`ctx_shell`
forward successfully over the persistent MCP session.
Note: `listTools` reflects LeanCTX's active profile + dynamic tool categories
(returned 12 in a fresh session, not all 79); the agent can use
`ctx_discover_tools` / `ctx_load_tools` to reach more — the proxy is a
passthrough.
