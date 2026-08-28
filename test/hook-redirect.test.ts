import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  redirectForTool,
  REDIRECT_DENY_THRESHOLD,
  runHookRedirect,
  type RedirectCounter,
} from '../src/cli/commands/hook-redirect';

function payload(toolName: string, toolInput: unknown): string {
  return JSON.stringify({ hookType: 'PreToolUse', toolName, toolInput, sessionId: 's1' });
}

function memState() {
  const files = new Map<string, string>();
  return {
    read: (p: string) => files.get(p),
    write: (p: string, c: string) => void files.set(p, c),
    exists: (p: string) => files.has(p),
    mkdir: () => undefined,
    get: (p: string) => files.get(p),
  };
}

describe('redirectForTool', () => {
  it('redirects native code search to find_relevant_symbols', () => {
    expect(redirectForTool('grep_search', { query: 'onChange' })).toEqual({
      cadetTool: 'find_relevant_symbols',
      category: 'search',
      inputHint: 'onChange',
    });
    expect(redirectForTool('file_search', { query: '*.ts' })).toEqual({
      cadetTool: 'find_relevant_symbols',
      category: 'search',
      inputHint: '*.ts',
    });
  });

  it('redirects shell grep/rg to find_relevant_symbols', () => {
    expect(redirectForTool('run_in_terminal', { cmd: 'rg -n foo src' })).toEqual({
      cadetTool: 'find_relevant_symbols',
      category: 'search',
      inputHint: 'rg',
    });
  });

  it('redirects directory listing to find_relevant_symbols', () => {
    expect(redirectForTool('list_dir', { path: 'src' })).toEqual({
      cadetTool: 'find_relevant_symbols',
      category: 'list',
      inputHint: 'src',
    });
    expect(redirectForTool('read_directory', { path: 'src' })).toEqual({
      cadetTool: 'find_relevant_symbols',
      category: 'list',
      inputHint: 'src',
    });
  });

  it('redirects code-file reads to optimize_context', () => {
    expect(redirectForTool('read_file', { file_path: 'src/foo.ts' })).toEqual({
      cadetTool: 'optimize_context',
      category: 'read',
      inputHint: 'src/foo.ts',
    });
  });

  it('does not redirect non-code reads', () => {
    expect(redirectForTool('read_file', { file_path: 'assets/logo.png' })).toBeUndefined();
    expect(redirectForTool('read_file', { file_path: 'README.md' })).toBeUndefined();
  });

  it('redirects noisy shell commands to compress_command_output (RTK)', () => {
    expect(redirectForTool('run_in_terminal', { cmd: 'git status' })).toEqual({
      cadetTool: 'compress_command_output',
      category: 'shell',
      inputHint: 'git status',
    });
    expect(redirectForTool('terminal', { command: './build_editor.sh' })).toEqual({
      cadetTool: 'compress_command_output',
      category: 'shell',
      inputHint: './build_editor.sh',
    });
    expect(redirectForTool('run_in_terminal', { cmd: 'vitest run' })).toEqual({
      cadetTool: 'compress_command_output',
      category: 'shell',
      inputHint: 'vitest run',
    });
  });

  it('does not redirect quiet shell commands', () => {
    expect(redirectForTool('run_in_terminal', { cmd: 'cd /tmp' })).toBeUndefined();
    expect(redirectForTool('run_in_terminal', { cmd: 'echo hi' })).toBeUndefined();
  });

  it('allows unrelated tools', () => {
    expect(redirectForTool('edit_file', { path: 'src/foo.ts' })).toBeUndefined();
    expect(redirectForTool('apply_patch', {})).toBeUndefined();
  });
});

describe('runHookRedirect', () => {
  it('denies a native search on first hit and redirects to find_relevant_symbols', async () => {
    const state = memState();
    let out = '';
    const exit = await runHookRedirect(
      {},
      { readStdin: async () => payload('grep_search', { query: 'foo' }), writeOut: (l) => (out = l), state },
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { permissionDecision: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('find_relevant_symbols');
  });

  it('allows through after the deny threshold (safety valve)', async () => {
    const state = memState();
    const counter: RedirectCounter = {
      search: REDIRECT_DENY_THRESHOLD,
      list: 0,
      read: 0,
      shell: 0,
      lastTimestamp: Date.now(),
    };
    const stateDir = '/x';
    state.write(join(stateDir, 's1.redirect.json'), JSON.stringify(counter));
    let out = '';
    const exit = await runHookRedirect(
      { stateDir },
      { readStdin: async () => payload('grep_search', { query: 'foo' }), writeOut: (l) => (out = l), state },
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { permissionDecision: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('find_relevant_symbols');
  });

  it('allows unrelated tools without extra context', async () => {
    let out = '';
    const exit = await runHookRedirect(
      {},
      { readStdin: async () => payload('edit_file', { path: 'src/a.ts' }), writeOut: (l) => (out = l) },
    );
    expect(exit).toBe(0);
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { permissionDecision: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(parsed.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it('no-ops on empty stdin', async () => {
    let out = 'sentinel';
    const exit = await runHookRedirect(
      {},
      { readStdin: async () => '', writeOut: (l) => (out = l) },
    );
    expect(exit).toBe(0);
    expect(out).toBe('sentinel');
  });
});
