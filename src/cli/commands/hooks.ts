import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';
import type { CliCommand } from '../types';

/**
 * VS Code Copilot Chat Hooks lifecycle events. Every event maps to a cadet
 * handler command that saves tokens at that point in the agent session.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A single command hook entry in a VS Code Copilot Chat Hooks config. */
export interface HookCommand {
  type: 'command';
  command: string;
}

/** Shape of the generated VS Code Copilot Chat Hooks config file. */
export interface CopilotHooksConfig {
  hooks: Partial<Record<HookEvent, HookCommand[]>>;
}

export interface HooksDeps {
  /** Override the output sink (tests). */
  log?: (line: string) => void;
  /** Override the error sink (tests). */
  err?: (line: string) => void;
  /** Override the filesystem writer (tests). */
  write?: (filePath: string, content: string) => void;
}

export interface HooksOptions {
  /** Recommended tool to nudge toward (defaults to find_relevant_symbols). */
  tool?: string;
  /** Directory to write the config into (defaults to ~/.copilot/hooks). */
  outDir?: string;
}

export interface ParsedHooksArgs {
  tool?: string;
  outDir?: string;
}

/** Supported default recommended tool when none is provided. */
export const DEFAULT_RECOMMENDED_TOOL = 'find_relevant_symbols';

/** Directory VS Code reads Copilot Chat Hooks from (global, ~/.copilot/hooks). */
export const DEFAULT_HOOKS_DIR = join(os.homedir(), '.copilot', 'hooks');

/** File name written into the hooks directory. */
export const DEFAULT_HOOKS_FILENAME = 'cadet-token-saver.json';

/**
 * Parse `hooks` arguments. Accepts a positional recommended-tool name, plus
 * `--tool <name>` and `--out <dir>` flags. `--out` wins over the positional
 * default when both are present.
 */
export function parseHooksArgs(args: readonly string[]): ParsedHooksArgs {
  let tool: string | undefined;
  let outDir: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--tool') {
      const value = args[i + 1];
      if (value !== undefined) {
        tool = value;
        i += 1;
      }
      continue;
    }
    if (arg === '--out') {
      const value = args[i + 1];
      if (value !== undefined) {
        outDir = value;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  if (tool === undefined && positional.length > 0) {
    tool = positional[0];
  }
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
  };
}

/**
 * Build the full Copilot Chat Hooks config installing every lifecycle event.
 * Each event wires to a `cadet-token-saver hook-*` handler that saves tokens at
 * that point in the agent session:
 *  - SessionStart: prime the session with memory hints + recommended tool.
 *  - UserPromptSubmit: classify the prompt and inject the strategy.
 *  - PreToolUse: remind toward the recommended tool (raw grep/read guard).
 *  - PostToolUse: record token-saving metrics per tool call.
 *  - PreCompact: export important context to memory before truncation.
 *  - SubagentStart/Stop: classify + track nested usage, aggregate + cleanup.
 *  - Stop: persist a session summary to memory and clean up hook state.
 */
export function buildHooksConfig(tool: string): CopilotHooksConfig {
  return {
    hooks: {
      SessionStart: [
        { type: 'command', command: 'cadet-token-saver hook-session-start' },
      ],
      UserPromptSubmit: [
        { type: 'command', command: 'cadet-token-saver hook-user-prompt' },
      ],
      PreToolUse: [
        {
          type: 'command',
          command: `cadet-token-saver hook-remind --tool ${tool}`,
        },
      ],
      PostToolUse: [
        { type: 'command', command: 'cadet-token-saver hook-post-tool' },
      ],
      PreCompact: [
        { type: 'command', command: 'cadet-token-saver hook-pre-compact' },
      ],
      SubagentStart: [
        { type: 'command', command: 'cadet-token-saver hook-subagent-start' },
      ],
      SubagentStop: [
        { type: 'command', command: 'cadet-token-saver hook-subagent-stop' },
      ],
      Stop: [{ type: 'command', command: 'cadet-token-saver hook-stop' }],
    },
  };
}

/** Resolve the output file: <outDir>/cadet-token-saver.json. */
export function defaultHooksFilePath(outDir: string): string {
  return join(outDir, DEFAULT_HOOKS_FILENAME);
}

/**
 * Write the full VS Code Copilot Chat Hooks config into the global
 * `~/.copilot/hooks` directory, installing all lifecycle events. VS Code reads
 * Copilot Chat Hooks from `~/.copilot/hooks/*.json`, so writing there makes all
 * hooks live automatically (reload the window to pick them up).
 */
export function runHooks(
  options: HooksOptions = {},
  deps: HooksDeps = {},
): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const write = deps.write ?? ((filePath, content) => writeFileSync(filePath, content, 'utf8'));

  const tool = options.tool ?? DEFAULT_RECOMMENDED_TOOL;
  const outDir = options.outDir ?? DEFAULT_HOOKS_DIR;

  if (!tool.trim()) {
    err('[cadet-token-saver] hooks: tool name must not be empty.');
    return 1;
  }

  const config = buildHooksConfig(tool);
  const filePath = resolve(defaultHooksFilePath(outDir));
  const content = `${JSON.stringify(config, null, 2)}\n`;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    write(filePath, content);
  } catch (caught) {
    err(
      `[cadet-token-saver] hooks: failed to write ${filePath}: ${(caught as Error).message}`,
    );
    return 1;
  }

  log(`[cadet-token-saver] hooks: wrote ${filePath}`);
  log(`  Recommended tool: ${tool}`);
  log(`  Installed events: ${HOOK_EVENTS.join(', ')}`);
  log(
    '  VS Code auto-loads Copilot Chat Hooks from ~/.copilot/hooks — reload the window for it to take effect.',
  );
  return 0;
}

export const hooksCommand: CliCommand = {
  name: 'hooks',
  description: 'Install all VS Code Copilot Chat Hooks lifecycle events (default ~/.copilot/hooks/cadet-token-saver.json)',
  usage: 'cadet-token-saver hooks [tool] [--tool <name>] [--out <dir>]',
  run(args: readonly string[]): number {
    const { tool, outDir } = parseHooksArgs(args);
    return runHooks({
      ...(tool !== undefined ? { tool } : {}),
      ...(outDir !== undefined ? { outDir } : {}),
    });
  },
};
