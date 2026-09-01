import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import type { CliCommand } from '../types';
import { recordMetrics } from './hook-lifecycle';

/**
 * PreToolUse "redirect" hook — forces adoption of the cheap cadet tools by
 * intercepting the expensive native tools (raw code search, directory dumps,
 * full-file reads, and noisy shell commands) and denying them in favour of the
 * compressed cadet replacement. Every redirect targets a cadet MCP tool, so all
 * traffic flows through the brainstem MCP:
 *   - code search / directory dumps  → find_relevant_symbols   (Serena-backed)
 *   - full-file code reads           → optimize_context        (LeanCTX-backed)
 *   - noisy shell commands           → optimize_context (LeanCTX-backed)
 *
 * Rationale (from live adoption stats): recommendation-only steering
 * (`tool_plan.recommended_tools` + `follow_tool_plan`) is largely ignored — the
 * model keeps calling native `grep_search`/`list_dir`/`read_file`/`run_in_terminal`
 * instead of the cadet tools, so 0 tokens are saved. LeanCTX solves the same
 * problem by intercepting at the PreToolUse layer and *denying* the native tool
 * with a strong redirect to its compressed MCP tool. This hook mirrors that
 * "Replace"-style redirect.
 *
 * Safety valve: to avoid permanently bricking the agent (it must eventually read
 * a file or run a command), each native tool *category* is denied a bounded
 * number of times per session window. After the threshold the call is allowed
 * through with a reminder, so the agent is steered hard up front without being
 * stuck forever.
 */
export interface RedirectCounter {
  search: number;
  list: number;
  read: number;
  shell: number;
  lastTimestamp: number;
}

/** Shell commands treated as raw code search (redirect → find_relevant_symbols). */
const GREP_SHELL_COMMANDS = ['grep', 'rg', 'ag', 'ack', 'fgrep', 'egrep'];
/** Shell commands that list a directory (redirect → find_relevant_symbols). */
const LIST_SHELL_COMMANDS = ['ls', 'find', 'tree', 'dir'];
/** Shell commands that read file content (redirect → optimize_context). */
const READ_SHELL_COMMANDS = ['cat', 'head', 'tail', 'sed', 'less', 'more', 'bat', 'get-content', 'gc'];

/** Native tool names that execute shell commands (candidate for LeanCTX redirect). */
const SHELL_TOOL_NAMES = ['run_in_terminal', 'terminal', 'bash', 'powershell', 'shell', 'cmd', 'execute_command', 'run_command'];

/**
 * True when a shell command is READ-ONLY and its output is likely large — the
 * only case worth redirecting to optimize_context. State-changing commands (npm
 * install, git commit/push, builds that produce artifacts) MUST NOT be redirected:
 * they have to actually run.
 */
function isReadonlyNoisyShell(cmd: string): boolean {
  const lower = cmd.trim().toLowerCase();
  // read-only git subcommands with typically-large output
  if (/^git\s+(status|diff|log|show|branch|remote|submodule|shortlog)/.test(lower)) {
    return true;
  }
  // directory listing
  if (/^(ls|ls\s|find|tree|dir|dir\s)/.test(lower)) {
    return true;
  }
  // test runners (read-only; output is often large and repetitive)
  if (/\b(vitest|jest|pytest|mocha|go test|cargo test|npm test|pnpm test|yarn test)\b/.test(lower)) {
    return true;
  }
  return false;
}

/** True when a native tool executes a read-only, likely-noisy shell command. */
function isNoisyShellCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): { cmd: string } | undefined {
  const name = toolName.toLowerCase();
  const isShellTool = SHELL_TOOL_NAMES.some((t) => name.includes(t));
  if (!isShellTool) {
    return undefined;
  }
  const cmd =
    (toolInput['cmd'] as string | undefined) ??
    (toolInput['command'] as string | undefined) ??
    (toolInput['commandLine'] as string | undefined) ??
    (toolInput['text'] as string | undefined);
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    return undefined;
  }
  return isReadonlyNoisyShell(cmd) ? { cmd: cmd.trim() } : undefined;
}

/** Suffixes where a native read should be redirected to optimize_context. Covers
 * the text-like file types whose raw read tends to dump large amounts of tokens:
 * source code, docs/markdown, config/data, and markup. Generic — no engine- or
 * project-specific asset types (the hook is a general-purpose token saver). */
const REDIRECT_READ_EXTENSIONS = new Set([
  // source
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs', '.go', '.rs', '.java',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.swift', '.kt',
  '.sh', '.ps1', '.sql', '.lua',
  // config / data
  '.json', '.yaml', '.yml', '.toml', '.csv', '.log',
  // docs / markdown
  '.md', '.markdown', '.rst', '.txt',
  // markup
  '.xml', '.html', '.htm',
]);

/** Max denies per category within a window before the call passes through. */
export const REDIRECT_DENY_THRESHOLD = 5;
/** Seconds that reset the per-category deny counters between bursts. */
export const REDIRECT_WINDOW_SECONDS = 600;

export interface RedirectOptions {
  /** No options today; kept for symmetry with other hook handlers. */
  stateDir?: string;
}

export interface RedirectDeps {
  /** Override stdin reader (tests). */
  readStdin?: () => Promise<string>;
  /** Override stdout writer (tests). */
  writeOut?: (line: string) => void;
  /** Override the state filesystem helpers (tests). */
  state?: {
    read?: (path: string) => string | undefined;
    write?: (path: string, content: string) => void;
    exists?: (path: string) => boolean;
    mkdir?: (path: string) => void;
  };
  /**
   * Override the metrics sink (tests). Defaults to the real `recordMetrics`, which
   * writes a `pre_tool_use` event so `stats` shows the PreToolUse hook firing.
   */
  recordMetrics?: (event: RedirectMetricEvent) => void;
}

/** Shape of the metrics event the PreToolUse redirect hook records. */
export interface RedirectMetricEvent {
  sessionId: string;
  tool: string;
  operation: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTokensSaved: number;
  origin?: string;
}

interface ToolCallPayload {
  hookType?: string;
  hook_event_name?: string;
  toolName?: string;
  tool_name?: string;
  toolInput?: Record<string, unknown>;
  tool_input?: Record<string, unknown>;
  sessionId?: string;
  session_id?: string;
  modelId?: string;
  model_id?: string;
  toolUseID?: string;
  tool_use_id?: string;
}

/** The JSON envelope VS Code Copilot Chat Hooks expect on stdout. */
interface HookOutput {
  hookSpecificOutput?: {
    permissionDecision: 'allow' | 'deny';
    additionalContext?: string;
  };
}

/** A detected native tool that should be redirected to a cadet tool. */
export interface RedirectTarget {
  /** cadet MCP tool the model should call instead. */
  cadetTool: 'find_relevant_symbols' | 'optimize_context';
  /** Per-session counter category used for the safety valve. */
  category: 'search' | 'list' | 'read' | 'shell';
  /** What to pass as the cadet tool's primary input (path/pattern), if derivable. */
  inputHint?: string;
}

function commandName(toolInput: Record<string, unknown>): string | undefined {
  const cmd = toolInput['cmd'] ?? toolInput['command'] ?? toolInput['commandLine'];
  if (typeof cmd !== 'string') {
    return undefined;
  }
  const trimmed = cmd.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(/\s+/)[0]?.split(/[\\/]/).pop()?.toLowerCase();
}

function pathFromInput(toolInput: Record<string, unknown>): string | undefined {
  const p = toolInput['path'] ?? toolInput['file_path'] ?? toolInput['filePath'];
  return typeof p === 'string' ? p : undefined;
}

function isCodeFile(path: string | undefined): boolean {
  if (path === undefined) {
    return false;
  }
  const suffix = path.toLowerCase();
  return REDIRECT_READ_EXTENSIONS.has(suffix.slice(suffix.lastIndexOf('.')));
}

/**
 * Map a native PreToolUse tool call to the cadet tool that should replace it.
 * Returns undefined when the call is fine as-is.
 */
export function redirectForTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): RedirectTarget | undefined {
  const name = toolName.toLowerCase();
  const path = pathFromInput(toolInput);
  const cmd = commandName(toolInput);

  // Native code search — grep_search / file_search / search / shell grep.
  const isSearch =
    name.includes('grep') ||
    name.includes('file_search') ||
    name === 'search' ||
    name.includes('search_for_pattern') ||
    (cmd !== undefined && GREP_SHELL_COMMANDS.includes(cmd));
  if (isSearch) {
    const query =
      (toolInput['query'] as string | undefined) ??
      (toolInput['pattern'] as string | undefined) ??
      cmd;
    return {
      cadetTool: 'find_relevant_symbols',
      category: 'search',
      ...(typeof query === 'string' && query.length > 0 ? { inputHint: query } : {}),
    };
  }

  // Native directory listing — list_dir / read_directory / shell ls|find.
  const isList =
    name.includes('list_dir') ||
    name.includes('read_directory') ||
    name === 'list_directory' ||
    (cmd !== undefined && LIST_SHELL_COMMANDS.includes(cmd));
  if (isList) {
    return {
      cadetTool: 'find_relevant_symbols',
      category: 'list',
      ...(path !== undefined ? { inputHint: path } : {}),
    };
  }

  // Native full-file read of code — read_file / read on a code path, or shell cat.
  const isRead =
    (name.includes('read_file') || name === 'read') && isCodeFile(path) ||
    (cmd !== undefined && READ_SHELL_COMMANDS.includes(cmd) && isCodeFile(path));
  if (isRead) {
    return {
      cadetTool: 'optimize_context',
      category: 'read',
      ...(path !== undefined ? { inputHint: path } : {}),
    };
  }

  // Noisy shell command — build/test/git/etc → optimize_context (LeanCTX).
  const noisy = isNoisyShellCall(toolName, toolInput);
  if (noisy !== undefined) {
    return {
      cadetTool: 'optimize_context',
      category: 'shell',
      inputHint: noisy.cmd,
    };
  }

  return undefined;
}

function freshCounter(now: number): RedirectCounter {
  return { search: 0, list: 0, read: 0, shell: 0, lastTimestamp: now };
}

/** Load the per-session redirect counter (best-effort). */
export function loadRedirectCounter(
  path: string,
  deps: RedirectDeps = {},
): RedirectCounter {
  const read = deps.state?.read ?? ((p: string) => {
    if (!existsSync(p)) {
      return undefined;
    }
    return readFileSync(p, 'utf8');
  });
  try {
    const raw = read(path);
    if (raw === undefined) {
      return freshCounter(Date.now());
    }
    const parsed = JSON.parse(raw) as RedirectCounter;
    if (
      typeof parsed.search !== 'number' ||
      typeof parsed.list !== 'number' ||
      typeof parsed.read !== 'number' ||
      typeof parsed.shell !== 'number'
    ) {
      return freshCounter(Date.now());
    }
    return parsed;
  } catch {
    return freshCounter(Date.now());
  }
}

/** Persist the per-session redirect counter (best-effort). */
export function saveRedirectCounter(
  path: string,
  counter: RedirectCounter,
  deps: RedirectDeps = {},
): void {
  const mkdir = deps.state?.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const write = deps.state?.write ?? ((p: string, content: string) => writeFileSync(p, content, 'utf8'));
  try {
    mkdir(dirname(path));
    write(path, JSON.stringify(counter));
  } catch {
    // best-effort — a failure never breaks the hook.
  }
}

function denyOutput(target: RedirectTarget): HookOutput {
  const hint = target.inputHint !== undefined ? ` (target: ${target.inputHint})` : '';
  let instruction: string;
  switch (target.cadetTool) {
    case 'find_relevant_symbols':
      instruction = `Use find_relevant_symbols to locate symbols/patterns across the project${hint} instead of a raw search/directory dump.`;
      break;
    case 'optimize_context':
      instruction = target.category === 'shell'
        ? `Use optimize_context to gather concise context for the shell command "${target.inputHint ?? '<cmd>'}" instead of a raw shell dump${hint}.`
        : `Use optimize_context with target ${target.inputHint ?? '<path>'} to get concise file context instead of a raw full-file read${hint}.`;
      break;
  }
  return {
    hookSpecificOutput: {
      permissionDecision: 'deny',
      additionalContext:
        `Native tool denied: this call is expensive on tokens. ${instruction} ` +
        `Call the cadet MCP tool (${target.cadetTool}) — it is auto-approved and available. ` +
        `Do not retry the native tool; use ${target.cadetTool} instead.`,
    },
  };
}

function allowOutput(additionalContext?: string): HookOutput {
  return {
    hookSpecificOutput: {
      permissionDecision: 'allow',
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    },
  };
}

/** Soft-redirect nudge: allow the native tool but point to the cadet replacement. */
function remindMessage(target: RedirectTarget): string {
  const hint = target.inputHint !== undefined ? ` (target: ${target.inputHint})` : '';
  return `Consider using ${target.cadetTool}${hint} instead — it returns the same information with far fewer tokens.`;
}

/**
 * Handle a single PreToolUse hook invocation: deny the expensive native search /
 * list / code-read tools and redirect to the cadet replacement. Reads the VS Code
 * payload from stdin. Emits nothing on an empty/invalid payload (safe no-op).
 */
export async function runHookRedirect(
  options: RedirectOptions = {},
  deps: RedirectDeps = {},
): Promise<number> {
  const readStdin = deps.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  });
  const writeOut = deps.writeOut ?? ((line: string) => process.stdout.write(line));
  const stateDir =
    options.stateDir ??
    join(os.homedir(), '.local', 'state', 'cadet-brainstem', 'hooks');

  const raw = (await readStdin()).trim();
  if (!raw) {
    return 0;
  }

  let payload: ToolCallPayload;
  try {
    payload = JSON.parse(raw) as ToolCallPayload;
  } catch {
    writeOut(JSON.stringify(allowOutput()));
    return 0;
  }

  const toolName = payload.tool_name ?? payload.toolName ?? '';
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';

  // Record that the PreToolUse hook fired, so `stats` shows it active even when
  // it allows (no deny). Best-effort, injected sink for tests.
  const record =
    deps.recordMetrics ?? ((e: RedirectMetricEvent) => recordMetrics({}, e));
  try {
    record({
      sessionId,
      tool: toolName || 'tool',
      operation: 'pre_tool_use',
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTokensSaved: 0,
      origin: 'hook',
    });
  } catch {
    // best-effort — a metrics failure never breaks the hook
  }

  const target = redirectForTool(toolName, toolInput);
  if (target === undefined) {
    writeOut(JSON.stringify(allowOutput()));
    return 0;
  }

  const now = Date.now();
  const stateFile = join(stateDir, `${sessionId}.redirect.json`);
  const counter = loadRedirectCounter(stateFile, deps);

  // Reset the window when the last deny was long ago.
  if (now - counter.lastTimestamp > REDIRECT_WINDOW_SECONDS * 1000) {
    counter.search = 0;
    counter.list = 0;
    counter.read = 0;
    counter.shell = 0;
  }
  counter.lastTimestamp = now;

  const count = counter[target.category];
  if (count >= REDIRECT_DENY_THRESHOLD) {
    // Safety valve: let the call through, but keep steering via a reminder.
    writeOut(JSON.stringify(allowOutput(remindMessage(target))));
    return 0;
  }
  counter[target.category] = count + 1;
  saveRedirectCounter(stateFile, counter, deps);
  // Hard-deny ONLY search/list — they are cleanly replaceable by
  // find_relevant_symbols (the model still gets the same search results).
  // Reads and shell are SOFT-redirected (allow + remind): hard-denying them
  // would block legitimate file reads needed for edits and state-changing /
  // necessary shell commands (install/test/build), which optimize_context
  // (read-only) cannot replace.
  if (target.category === 'search' || target.category === 'list') {
    writeOut(JSON.stringify(denyOutput(target)));
  } else {
    writeOut(JSON.stringify(allowOutput(remindMessage(target))));
  }
  return 0;
}

export const hookRedirectCommand: CliCommand = {
  name: 'hook-redirect',
  description:
    'PreToolUse hook handler that denies native code-search/list/read tools and redirects to the cadet compressed tools (find_relevant_symbols / optimize_context)',
  usage: 'cadet-brainstem hook-redirect',
  run(): Promise<number> {
    return runHookRedirect();
  },
};
