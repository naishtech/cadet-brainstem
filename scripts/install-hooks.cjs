#!/usr/bin/env node
/**
 * Best-effort auto-install of the Cadet Brainstem Copilot Chat Hooks on
 * `npm install`, so steering works out of the box. Non-fatal: if it can't run,
 * it warns and tells the user to run `cadet-brainstem hooks` manually.
 *
 * IMPORTANT: this mirrors `buildHooksConfig()`'s default output (no PreToolUse
 * redirect — that stays opt-in via `--pretool`/`--remind`). If you change the
 * hooks shape in `src/cli/commands/hooks.ts`, update this file to match.
 *
 * It only writes when the hooks file does not already exist, so a user's
 * customized (e.g. `--pretool`) config is never overwritten.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STEERING_HOOK_TIMEOUT_MS = 90_000;

function buildDefaultHooksConfig() {
  const hook = (command, timeout) =>
    timeout === undefined ? { type: 'command', command } : { type: 'command', command, timeout };
  return {
    hooks: {
      SessionStart: [hook('cadet-brainstem hook-session-start')],
      UserPromptSubmit: [hook('cadet-brainstem hook-user-prompt', STEERING_HOOK_TIMEOUT_MS)],
      PostToolUse: [hook('cadet-brainstem hook-post-tool')],
      PreCompact: [hook('cadet-brainstem hook-pre-compact')],
      SubagentStart: [hook('cadet-brainstem hook-subagent-start', STEERING_HOOK_TIMEOUT_MS)],
      SubagentStop: [hook('cadet-brainstem hook-subagent-stop')],
      Stop: [hook('cadet-brainstem hook-stop')],
    },
  };
}

function main() {
  const outDir = path.join(os.homedir(), '.copilot', 'hooks');
  const filePath = path.join(outDir, 'cadet-brainstem.json');
  try {
    const expected = `${JSON.stringify(buildDefaultHooksConfig(), null, 2)}\n`;
    if (fs.existsSync(filePath)) {
      let existing = '';
      try {
        existing = fs.readFileSync(filePath, 'utf8');
      } catch {
        /* treat unreadable as not matching */
      }
      if (existing.trim() === expected.trim()) {
        console.log('[cadet-brainstem] hooks: already up to date.');
      } else {
        // The existing hooks config differs from this version's defaults — it
        // may be stale (from an older install) or customized (e.g. --pretool).
        // Do NOT silently overwrite; clearly tell the user how to update.
        console.warn('[cadet-brainstem] WARNING: existing hooks config was NOT updated.');
        console.warn(`  File: ${filePath}`);
        console.warn('  It may be stale (from an older version) or customized (e.g. --pretool).');
        console.warn('  To overwrite with the current defaults, run: cadet-brainstem hooks --force');
      }
      return 0;
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(filePath, expected, 'utf8');
    console.log(`[cadet-brainstem] hooks: installed to ${filePath}`);
    console.log('  Reload the VS Code window to activate steering on user prompts.');
  } catch (err) {
    console.warn(`[cadet-brainstem] could not auto-install hooks (${err.message}).`);
    console.warn('  Run `cadet-brainstem hooks` manually to install them.');
    return 1;
  }
  return 0;
}

process.exitCode = main();
