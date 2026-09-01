import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  /**
   * Max ms VS Code waits for the hook before aborting. VS Code's default is
   * 30s, which is too short for hooks that run the local steering (~20-45s),
   * so the LLM-calling hooks set an explicit higher timeout.
   */
  timeout?: number;
}

/** Timeout (ms) for hooks that call the local LLM steering. */
export const STEERING_HOOK_TIMEOUT_MS = 90_000;

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
  /**
   * Include the PreToolUse redirect/remind hooks (default false). They intercept
   * every tool call and were found too intrusive for daily dev work, so they are
   * opt-in. Enable with `--pretool`. hook-redirect hard-denies raw search/list
   * and redirects to the recommended tool; hook-remind allows + nudges only
   * after repeated raw bursts.
   */
  pretool?: boolean;
  /**
   * Include ONLY the PreToolUse `hook-remind` nudge (default false). Unlike
   * `--pretool`, this does NOT install `hook-redirect`, so native search/read
   * is never hard-denied — the agent is merely reminded toward the recommended
   * tool after repeated raw calls. Enable with `--remind`.
   */
  remind?: boolean;
  /**
   * Only write the config if the hooks file does not already exist. Used by the
   * install-time auto-setup so we never clobber a user's customized (e.g.
   * `--pretool`) hooks config. Enable with `--if-missing`.
   */
  ifMissing?: boolean;
  /**
   * Overwrite the hooks config even if it already exists (e.g. to pick up the
   * hooks from a newly installed version). Enable with `--force`. Takes
   * precedence over `--if-missing`.
   */
  force?: boolean;
}

export interface ParsedHooksArgs {
  tool?: string;
  outDir?: string;
  pretool?: boolean;
  remind?: boolean;
  ifMissing?: boolean;
  force?: boolean;
}

/** Supported default recommended tool when none is provided. */
export const DEFAULT_RECOMMENDED_TOOL = 'find_relevant_symbols';

/** Directory VS Code reads Copilot Chat Hooks from (global, ~/.copilot/hooks). */
export const DEFAULT_HOOKS_DIR = join(os.homedir(), '.copilot', 'hooks');

/** File name written into the hooks directory. */
export const DEFAULT_HOOKS_FILENAME = 'cadet-brainstem.json';

/**
 * Parse `hooks` arguments. Accepts a positional recommended-tool name, plus
 * `--tool <name>` and `--out <dir>` flags. `--out` wins over the positional
 * default when both are present.
 */
export function parseHooksArgs(args: readonly string[]): ParsedHooksArgs {
  let tool: string | undefined;
  let outDir: string | undefined;
  let pretool = false;
  let remind = false;
  let ifMissing = false;
  let force = false;
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
    if (arg === '--pretool') {
      pretool = true;
      continue;
    }
    if (arg === '--remind') {
      remind = true;
      continue;
    }
    if (arg === '--if-missing') {
      ifMissing = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
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
    ...(pretool ? { pretool: true } : {}),
    ...(remind ? { remind: true } : {}),
    ...(ifMissing ? { ifMissing: true } : {}),
    ...(force ? { force: true } : {}),
  };
}

/**
 * Build the Copilot Chat Hooks config installing every lifecycle event. Each
 * event wires to a `cadet-brainstem hook-*` handler that saves tokens at that
 * point in the agent session:
 *  - SessionStart: prime the session with memory hints + recommended tool.
 *  - UserPromptSubmit: steer the prompt and inject the strategy.
 *  - PreToolUse (OPT-IN via --pretool): redirect native search/list to cadet
 *    tools, then remind toward the recommended tool. Off by default — it
 *    intercepts every tool call and proved too intrusive for daily dev.
 *  - PostToolUse: record token-saving metrics per tool call.
 *  - PreCompact: export important context to memory before truncation.
 *  - SubagentStart/Stop: steer + track nested usage, aggregate + cleanup.
 *  - Stop: persist a session summary to memory and clean up hook state.
 */
export function buildHooksConfig(
  tool: string,
  opts: { pretool?: boolean; remind?: boolean } = {},
): CopilotHooksConfig {
  return {
    hooks: {
      SessionStart: [
        { type: 'command', command: 'cadet-brainstem hook-session-start' },
      ],
      UserPromptSubmit: [
        {
          type: 'command',
          command: 'cadet-brainstem hook-user-prompt',
          timeout: STEERING_HOOK_TIMEOUT_MS,
        },
      ],
      PreToolUse: [
        {
          type: 'command',
          command: 'cadet-brainstem hook-procedure-review',
        },
      ],
      ...(opts.pretool === true
        ? {
            PreToolUse: [
              {
                type: 'command',
                command: 'cadet-brainstem hook-procedure-review',
              },
              {
                // Redirects native code search / directory dumps to the cadet
                // compressed tools — forces real adoption instead of
                // recommendation-only steering.
                type: 'command',
                command: 'cadet-brainstem hook-redirect',
              },
              {
                type: 'command',
                command: `cadet-brainstem hook-remind --tool ${tool}`,
              },
            ],
          }
        : opts.remind === true
          ? {
              // Remind-only nudge: allow + steer toward the recommended tool
              // after repeated raw search/read bursts, without hard-denying
              // native tools.
              PreToolUse: [
                {
                  type: 'command',
                  command: 'cadet-brainstem hook-procedure-review',
                },
                {
                  type: 'command',
                  command: `cadet-brainstem hook-remind --tool ${tool}`,
                },
              ],
            }
          : {}),
      PostToolUse: [
        { type: 'command', command: 'cadet-brainstem hook-post-tool' },
      ],
      PreCompact: [
        { type: 'command', command: 'cadet-brainstem hook-pre-compact' },
      ],
      SubagentStart: [
        {
          type: 'command',
          command: 'cadet-brainstem hook-subagent-start',
          timeout: STEERING_HOOK_TIMEOUT_MS,
        },
      ],
      SubagentStop: [
        { type: 'command', command: 'cadet-brainstem hook-subagent-stop' },
      ],
      Stop: [{ type: 'command', command: 'cadet-brainstem hook-stop' }],
    },
  };
}

/** Resolve the output file: <outDir>/cadet-brainstem.json. */
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
    err('[cadet-brainstem] hooks: tool name must not be empty.');
    return 1;
  }

  const filePath = resolve(defaultHooksFilePath(outDir));
  const exists = existsSync(filePath);
  if (options.force === true) {
    // Force overwrite: proceed to write below.
  } else if (options.ifMissing === true && exists) {
    log(`[cadet-brainstem] hooks: ${filePath} already exists — leaving it unchanged.`);
    log('  To overwrite with the current defaults, run: cadet-brainstem hooks --force');
    return 0;
  }

  const config = buildHooksConfig(tool, {
    ...(options.pretool !== undefined ? { pretool: options.pretool } : {}),
    ...(options.remind !== undefined ? { remind: options.remind } : {}),
  });
  const content = `${JSON.stringify(config, null, 2)}\n`;

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    write(filePath, content);
  } catch (caught) {
    err(
      `[cadet-brainstem] hooks: failed to write ${filePath}: ${(caught as Error).message}`,
    );
    return 1;
  }

  const installed = Object.keys(config.hooks).join(', ');
  log(`[cadet-brainstem] hooks: wrote ${filePath}`);
  log(`  Recommended tool: ${tool}`);
  log(`  Installed events: ${installed}`);
  log(
    '  VS Code auto-loads Copilot Chat Hooks from ~/.copilot/hooks — reload the window for it to take effect.',
  );
  return 0;
}

export const hooksCommand: CliCommand = {
  name: 'hooks',
  description: 'Install VS Code Copilot Chat Hooks lifecycle events (default ~/.copilot/hooks/cadet-brainstem.json; PreToolUse is opt-in via --pretool, remind-only via --remind)',
  usage: 'cadet-brainstem hooks [tool] [--tool <name>] [--out <dir>] [--pretool] [--remind] [--if-missing] [--force]',
  run(args: readonly string[]): number {
    const { tool, outDir, pretool, remind, ifMissing, force } = parseHooksArgs(args);
    return runHooks({
      ...(tool !== undefined ? { tool } : {}),
      ...(outDir !== undefined ? { outDir } : {}),
      ...(pretool !== undefined ? { pretool } : {}),
      ...(remind !== undefined ? { remind } : {}),
      ...(ifMissing !== undefined ? { ifMissing } : {}),
      ...(force !== undefined ? { force } : {}),
    });
  },
};
