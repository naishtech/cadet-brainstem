import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOOKS_DIR,
  DEFAULT_HOOKS_FILENAME,
  DEFAULT_RECOMMENDED_TOOL,
  buildHooksConfig,
  defaultHooksFilePath,
  hooksCommand,
  parseHooksArgs,
  runHooks,
  type HooksDeps,
} from '../src/cli/commands/hooks';
import {
  GREP_THRESHOLD,
  READ_THRESHOLD,
  loadCounter,
  parseRemindArgs,
  runHookRemind,
  saveCounter,
  type RemindDeps,
} from '../src/cli/commands/hook-remind';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cts-hooks-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeHooksDeps(): {
  deps: HooksDeps;
  lines: string[];
  errors: string[];
  written: string;
} {
  const lines: string[] = [];
  const errors: string[] = [];
  let written = '';
  return {
    deps: {
      log: (line) => lines.push(line),
      err: (line) => errors.push(line),
      write: (_filePath, content) => {
        written = content;
      },
    },
    lines,
    errors,
    get written() {
      return written;
    },
  };
}

describe('parseHooksArgs', () => {
  it('parses a positional tool', () => {
    expect(parseHooksArgs(['leanctx_call'])).toEqual({ tool: 'leanctx_call' });
  });

  it('parses --tool and --out flags', () => {
    expect(parseHooksArgs(['--tool', 'find_relevant_symbols', '--out', '.hooks'])).toEqual({
      tool: 'find_relevant_symbols',
      outDir: '.hooks',
    });
  });

  it('parses --pretool flag', () => {
    expect(parseHooksArgs(['--pretool'])).toEqual({ pretool: true });
    expect(parseHooksArgs(['--tool', 'x', '--pretool'])).toEqual({ tool: 'x', pretool: true });
  });

  it('returns empty when nothing provided', () => {
    expect(parseHooksArgs([])).toEqual({});
  });
});

describe('buildHooksConfig', () => {
  it('installs all default lifecycle events without PreToolUse', () => {
    const config = buildHooksConfig('find_relevant_symbols');
    expect(config.hooks.SessionStart?.[0]!.command).toContain('hook-session-start');
    expect(config.hooks.UserPromptSubmit?.[0]!.command).toContain('hook-user-prompt');
    // PreToolUse is off by default (too intrusive for daily dev).
    expect(config.hooks.PreToolUse).toBeUndefined();
    expect(config.hooks.PostToolUse?.[0]!.command).toContain('hook-post-tool');
    expect(config.hooks.PreCompact?.[0]!.command).toContain('hook-pre-compact');
    expect(config.hooks.SubagentStart?.[0]!.command).toContain('hook-subagent-start');
    expect(config.hooks.SubagentStop?.[0]!.command).toContain('hook-subagent-stop');
    expect(config.hooks.Stop?.[0]!.command).toContain('hook-stop');
  });

  it('installs PreToolUse redirect + remind only when pretool is true', () => {
    const config = buildHooksConfig('find_relevant_symbols', { pretool: true });
    expect(config.hooks.PreToolUse?.[0]!.command).toContain('hook-redirect');
    expect(config.hooks.PreToolUse?.[1]!.command).toContain(
      'hook-remind --tool find_relevant_symbols',
    );
  });
});

describe('defaultHooksFilePath', () => {
  it('names the config file cadet-brainstem.json in the out dir', () => {
    expect(defaultHooksFilePath(join('proj', '.copilot', 'hooks'))).toBe(
      join('proj', '.copilot', 'hooks', 'cadet-brainstem.json'),
    );
  });
});

describe('runHooks', () => {
  it('writes the config into the global ~/.copilot/hooks by default', () => {
    const { deps, lines } = makeHooksDeps();
    const exit = runHooks({}, deps);
    expect(exit).toBe(0);
    expect(lines[0]).toContain(join(DEFAULT_HOOKS_DIR, DEFAULT_HOOKS_FILENAME));
  });

  it('writes into a custom --out dir', () => {
    const { deps, lines } = makeHooksDeps();
    const outDir = join(dir, 'hooks');
    const exit = runHooks({ outDir, tool: 'leanctx_call' }, deps);
    expect(exit).toBe(0);
    expect(lines[0]).toContain(join(outDir, DEFAULT_HOOKS_FILENAME));
    expect(lines).toContain('  Recommended tool: leanctx_call');
  });

  it('defaults the recommended tool when none is given', () => {
    const { deps, lines } = makeHooksDeps();
    runHooks({}, deps);
    expect(lines).toContain(`  Recommended tool: ${DEFAULT_RECOMMENDED_TOOL}`);
  });

  it('errors on an empty tool name', () => {
    const { deps, errors } = makeHooksDeps();
    const exit = runHooks({ tool: '  ' }, deps);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('tool name must not be empty');
  });
});

describe('hooksCommand', () => {
  it('runs successfully with a positional tool', () => {
    const exit = hooksCommand.run(['leanctx_call', '--out', dir], {
      cwd: dir,
    });
    expect(exit).toBe(0);
  });
});

// ── hook-remind ────────────────────────────────────────────────────────────

function makeRemindDeps(): { deps: RemindDeps; outputs: string[] } {
  const outputs: string[] = [];
  const state = new Map<string, string>();
  return {
    deps: {
      writeOut: (line) => outputs.push(line),
      state: {
        exists: (p) => state.has(p),
        read: (p) => state.get(p),
        write: (p, c) => {
          state.set(p, c);
        },
        mkdir: () => undefined,
      },
    },
    outputs,
  };
}

function payload(toolName: string, toolInput: Record<string, unknown> = {}, sessionId = 's1'): string {
  return JSON.stringify({ hookType: 'PreToolUse', toolName, toolInput, sessionId });
}

describe('runHookRemind', () => {
  it('allows a non-grep/read tool without reaching a threshold', async () => {
    const { deps, outputs } = makeRemindDeps();
    const exit = await runHookRemind(
      { tool: 'find_relevant_symbols', stateDir: dir },
      { ...deps, readStdin: async () => payload('edit_file', {}) },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(outputs[0]!).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies after too many consecutive greps and nudges the tool', async () => {
    const { deps, outputs } = makeRemindDeps();
    const options = { tool: 'find_relevant_symbols', stateDir: dir };
    for (let i = 0; i < GREP_THRESHOLD; i++) {
      await runHookRemind(options, {
        ...deps,
        readStdin: async () => payload('grep_search', { pattern: `x${i}` }),
      });
    }
    const last = JSON.parse(outputs[outputs.length - 1]!).hookSpecificOutput;
    expect(last.permissionDecision).toBe('deny');
    expect(last.additionalContext).toContain('find_relevant_symbols');
  });

  it('denies after too many consecutive code reads', async () => {
    const { deps, outputs } = makeRemindDeps();
    const options = { tool: 'leanctx_call', stateDir: dir };
    for (let i = 0; i < READ_THRESHOLD; i++) {
      await runHookRemind(options, {
        ...deps,
        readStdin: async () =>
          payload('read_file', { file_path: `src/foo${i}.ts` }),
      });
    }
    const last = JSON.parse(outputs[outputs.length - 1]!).hookSpecificOutput;
    expect(last.permissionDecision).toBe('deny');
    expect(last.additionalContext).toContain('leanctx_call');
  });

  it('resets counters when a symbolic tool is used', async () => {
    const { deps, outputs } = makeRemindDeps();
    const options = { tool: 'find_relevant_symbols', stateDir: dir };
    // Two greps, then a symbolic call, then two more greps (below threshold).
    for (let i = 0; i < 2; i++) {
      await runHookRemind(options, {
        ...deps,
        readStdin: async () => payload('grep_search', { pattern: 'a' }),
      });
    }
    await runHookRemind(options, {
      ...deps,
      readStdin: async () => payload('mcp_serena_find_symbol', {}),
    });
    for (let i = 0; i < 2; i++) {
      await runHookRemind(options, {
        ...deps,
        readStdin: async () => payload('grep_search', { pattern: 'b' }),
      });
    }
    const last = JSON.parse(outputs[outputs.length - 1]!).hookSpecificOutput;
    expect(last.permissionDecision).toBe('allow');
  });

  it('resets counters when a proxied cadet serena/leanctx tool is used', async () => {
    // serena and leanctx are proxied through the cadet MCP server, so the tool
    // names the LM calls are prefixed (mcp_cadet-token-s_*). These must still
    // reset the burst counter so the LM is never wrongly denied after using
    // the recommended tools.
    for (const symbolic of [
      'mcp_cadet-token-s_find_relevant_symbols',
      'mcp_cadet-token-s_serena_call',
      'mcp_cadet-token-s_leanctx_call',
      'mcp_cadet-token-s_optimize_context',
    ]) {
      const { deps, outputs } = makeRemindDeps();
      const options = { tool: 'find_relevant_symbols', stateDir: dir };
      const sid = `reset-${symbolic}`;
      for (let i = 0; i < 2; i++) {
        await runHookRemind(options, {
          ...deps,
          readStdin: async () =>
            payload('grep_search', { pattern: 'a' }, sid),
        });
      }
      await runHookRemind(options, {
        ...deps,
        readStdin: async () => payload(symbolic, {}, sid),
      });
      for (let i = 0; i < 2; i++) {
        await runHookRemind(options, {
          ...deps,
          readStdin: async () =>
            payload('grep_search', { pattern: 'b' }, sid),
        });
      }
      const last = JSON.parse(outputs[outputs.length - 1]!).hookSpecificOutput;
      expect(last.permissionDecision, `via ${symbolic}`).toBe('allow');
    }
  });

  it('is a no-op on empty stdin', async () => {
    const { deps, outputs } = makeRemindDeps();
    const exit = await runHookRemind(
      { tool: 'x', stateDir: dir },
      { ...deps, readStdin: async () => '' },
    );
    expect(exit).toBe(0);
    expect(outputs).toHaveLength(0);
  });

  it('parses a symbolic call via the recommended tool name', async () => {
    const { deps, outputs } = makeRemindDeps();
    const exit = await runHookRemind(
      { tool: 'find_relevant_symbols', stateDir: dir },
      {
        ...deps,
        readStdin: async () => payload('find_relevant_symbols', { query: 'x' }),
      },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(outputs[0]!).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('counter persistence', () => {
  it('loadCounter returns a fresh counter when the file is missing', () => {
    const counter = loadCounter(join(dir, 'nope.json'));
    expect(counter.grep).toBe(0);
    expect(counter.read).toBe(0);
  });

  it('saveCounter then loadCounter round-trips state', () => {
    const path = join(dir, 'counter.json');
    saveCounter(path, { grep: 2, read: 1, nonSymbolic: 3, lastTimestamp: 123 });
    const loaded = loadCounter(path);
    expect(loaded.grep).toBe(2);
    expect(loaded.read).toBe(1);
    expect(loaded.nonSymbolic).toBe(3);
  });
});

describe('parseRemindArgs', () => {
  it('parses --tool', () => {
    expect(parseRemindArgs(['--tool', 'leanctx_call'])).toEqual({ tool: 'leanctx_call' });
  });

  it('parses a positional tool', () => {
    expect(parseRemindArgs(['leanctx_call'])).toEqual({ tool: 'leanctx_call' });
  });

  it('returns empty when nothing provided', () => {
    expect(parseRemindArgs([])).toEqual({});
  });
});
