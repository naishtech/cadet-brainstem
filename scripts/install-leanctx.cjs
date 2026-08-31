#!/usr/bin/env node
/**
 * Best-effort: verify LeanCTX is available on PATH. cadet-brainstem proxies
 * lean-ctx through its own MCP server (`leanctx_call` / `leanctx_list_tools`),
 * so we deliberately do NOT run `lean-ctx setup` here — that command registers
 * lean-ctx as a direct MCP server in VS Code / Copilot CLI / Claude / Cursor /
 * JetBrains / Windsurf / Amazon Q / Continue / OpenClaw and spawns a syncing
 * daemon that re-registers it, which conflicts with the single-gateway design
 * (everything through cadet-brainstem). We only check the binary is present;
 * `cadet-brainstem doctor` reports deeper status. Non-fatal.
 */
const { spawnSync } = require('node:child_process');

const r = spawnSync('lean-ctx', ['--version'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});

if (r.error || r.status !== 0) {
  console.warn(
    '[cadet-brainstem] lean-ctx not found on PATH — cadet will run without lean-ctx tools. ' +
      'Install it, then verify with `cadet-brainstem doctor`.',
  );
  process.exitCode = 1;
} else {
  const version = (r.stdout || '').toString().trim().split('\n')[0] || 'present';
  console.log(`[cadet-brainstem] lean-ctx available (${version}).`);
}
