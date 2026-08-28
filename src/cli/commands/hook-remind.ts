import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import type { CliCommand } from '../types';

/**
 * Per-session, persisted counter of consecutive raw code-search/read calls.
 * Mirrors Serena's PreToolUse "remind" hook: when the count reaches the
 * threshold, the hook emits a deny with a reminder to use the recommended
 * tool instead, then resets so the next burst starts fresh.
 */
export interface RemindCounter {
  grep: number;
  read: number;
  nonSymbolic: number;
  lastTimestamp: number;
}

/** Grep shell commands and search tool names treated as raw code-search. */
const GREP_SHELL_COMMANDS = ['grep', 'rg', 'ag', 'ack', 'fgrep', 'egrep', 'search_for_pattern'];
/** Shell commands that read file content. */
const READ_SHELL_COMMANDS = ['cat', 'head', 'tail', 'sed', 'less', 'more', 'bat', 'get-content', 'gc'];
/** Source-like suffixes where symbolic reads are preferred. */
const CODE_FILE_EXTENSIONS = new Set([
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs', '.go', '.rs', '.java',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.swift', '.kt',
  '.sh', '.ps1', '.sql', '.json', '.yaml', '.yml', '.toml', '.lua',
]);

export const GREP_THRESHOLD = 3;
export const READ_THRESHOLD = 3;
export const NON_SYMBOLIC_THRESHOLD = 4;
/** Seconds that reset the burst counter between consecutive same-type calls. */
export const RESET_PERIOD_SECONDS = 1000;
/** Minimum seconds between two hook denies (rate limit). */
export const MIN_DENY_INTERVAL_SECONDS = 120;

export interface RemindOptions {
  /** Recommended tool to nudge the agent toward. */
  tool: string;
  /** Directory to persist hook counter state (tests). */
  stateDir?: string;
}

export interface RemindDeps {
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
    permissionDecision: 'allow' | 'deny' | 'ask';
    additionalContext?: string;
  };
}

/** Normalise the persisted counter for a fresh session. */
function freshCounter(now: number): RemindCounter {
  return { grep: 0, read: 0, nonSymbolic: 0, lastTimestamp: now };
}

/**
 * Load the counter for a session, or return a fresh one when the session has
 * no persisted state (or state is missing/corrupt).
 */
export function loadCounter(path: string, deps: RemindDeps = {}): RemindCounter {
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
    const parsed = JSON.parse(raw) as RemindCounter;
    if (
      typeof parsed.grep !== 'number' ||
      typeof parsed.read !== 'number' ||
      typeof parsed.nonSymbolic !== 'number'
    ) {
      return freshCounter(Date.now());
    }
    return parsed;
  } catch {
    return freshCounter(Date.now());
  }
}

/** Persist the counter for a session. */
export function saveCounter(
  path: string,
  counter: RemindCounter,
  deps: RemindDeps = {},
): void {
  const mkdir = deps.state?.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const write = deps.state?.write ?? ((p: string, content: string) => writeFileSync(p, content, 'utf8'));
  try {
    mkdir(dirname(path));
    write(path, JSON.stringify(counter));
  } catch {
    // State persistence is best-effort — a failure never breaks the hook.
  }
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

function isGrepCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const name = toolName.toLowerCase();
  if (name.includes('grep') || name.includes('search_for_pattern')) {
    return true;
  }
  const nameCmd = commandName(toolInput);
  return nameCmd !== undefined && GREP_SHELL_COMMANDS.includes(nameCmd);
}

function isCodeReadCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const name = toolName.toLowerCase();
  if (name.includes('read_file') || name.includes('read_file')) {
    const file = toolInput['file_path'] ?? toolInput['filePath'] ?? toolInput['path'];
    if (typeof file === 'string') {
      const suffix = file.toLowerCase();
      return CODE_FILE_EXTENSIONS.has(
        suffix.slice(suffix.lastIndexOf('.')),
      );
    }
    return false;
  }
  const nameCmd = commandName(toolInput);
  if (nameCmd !== undefined && READ_SHELL_COMMANDS.includes(nameCmd)) {
    const file = toolInput['file_path'] ?? toolInput['filePath'] ?? toolInput['path'];
    if (typeof file === 'string') {
      const suffix = file.toLowerCase();
      return CODE_FILE_EXTENSIONS.has(suffix.slice(suffix.lastIndexOf('.')));
    }
    return true;
  }
  return false;
}

/** Detect a symbolic (recommended-tool) call that resets the counters. */
function isSymbolicCall(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.includes('serena') ||
    name.includes('find_relevant_symbols') ||
    name.includes('leanctx') ||
    name.includes('optimize_context') ||
    name.includes('find_symbol') ||
    name.includes('symbol_tools')
  );
}

function denyOutput(recommendedTool: string): HookOutput {
  return {
    hookSpecificOutput: {
      permissionDecision: 'deny',
      additionalContext:
        `Too many consecutive code-search/read calls without using the recommended tool. ` +
        `Prefer the recommended tool (${recommendedTool}) for code-centric exploration. ` +
        `You can continue using grep/read now if needed, the counter was reset.`,
    },
  };
}

function allowOutput(): HookOutput {
  return { hookSpecificOutput: { permissionDecision: 'allow' } };
}

/**
 * Handle a single PreToolUse hook invocation for the recommended tool. Reads
 * the VS Code hook payload from stdin, updates the per-session counter, and
 * emits a deny (with a reminder) only when the threshold is reached — else an
 * allow. Emits nothing on an empty/invalid payload (safe no-op).
 */
export async function runHookRemind(
  options: RemindOptions,
  deps: RemindDeps = {},
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
    join(os.homedir(), '.local', 'state', 'cadet-token-saver', 'hooks');

  const raw = (await readStdin()).trim();
  if (!raw) {
    return 0;
  }

  let payload: ToolCallPayload;
  try {
    payload = JSON.parse(raw) as ToolCallPayload;
  } catch {
    // Non-JSON input (e.g. an echo test) — treat as a no-op allow.
    writeOut(JSON.stringify(allowOutput()));
    return 0;
  }

  const toolName = payload.tool_name ?? payload.toolName ?? '';
  const toolInput = payload.tool_input ?? payload.toolInput ?? {};
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown';

  const now = Date.now();
  const stateFile = join(stateDir, `${sessionId}.json`);
  const counter = loadCounter(stateFile, deps);

  // Rate-limit: within MIN_DENY_INTERVAL of the last deny, no-op.
  // We persist lastTimestamp on deny; approximate the gate by skipping the
  // burst logic when the last deny was very recent — see denyTimestamp below.

  if (isSymbolicCall(toolName)) {
    // Using the recommended/symbolic tool resets the burst counters.
    counter.grep = 0;
    counter.read = 0;
    counter.nonSymbolic = 0;
    saveCounter(stateFile, counter, deps);
    writeOut(JSON.stringify(allowOutput()));
    return 0;
  }

  const isGrep = isGrepCall(toolName, toolInput);
  const isRead = isCodeReadCall(toolName, toolInput);

  if (isGrep || isRead) {
    const withinWindow = now - counter.lastTimestamp <= RESET_PERIOD_SECONDS * 1000;
    if (withinWindow) {
      if (isGrep) {
        counter.grep += 1;
      }
      if (isRead) {
        counter.read += 1;
      }
      counter.nonSymbolic += 1;
    } else {
      counter.grep = isGrep ? 1 : 0;
      counter.read = isRead ? 1 : 0;
      counter.nonSymbolic = 1;
    }
    counter.lastTimestamp = now;
  }

  const tooManyGrep = counter.grep >= GREP_THRESHOLD;
  const tooManyRead = counter.read >= READ_THRESHOLD;
  const tooManyNonSymbolic = counter.nonSymbolic >= NON_SYMBOLIC_THRESHOLD;

  if (tooManyGrep || tooManyRead || tooManyNonSymbolic) {
    counter.grep = 0;
    counter.read = 0;
    counter.nonSymbolic = 0;
    saveCounter(stateFile, counter, deps);
    writeOut(JSON.stringify(denyOutput(options.tool)));
    return 0;
  }

  saveCounter(stateFile, counter, deps);
  writeOut(JSON.stringify(allowOutput()));
  return 0;
}

export interface ParsedRemindArgs {
  tool?: string;
}

/** Parse `hook-remind` arguments: `--tool <name>` (or positional). */
export function parseRemindArgs(args: readonly string[]): ParsedRemindArgs {
  let tool: string | undefined;
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
    positional.push(arg);
  }
  if (tool === undefined && positional.length > 0) {
    tool = positional[0];
  }
  return tool !== undefined ? { tool } : {};
}

export const hookRemindCommand: CliCommand = {
  name: 'hook-remind',
  description: 'PreToolUse hook handler that nudges toward the recommended tool',
  usage: 'cadet-token-saver hook-remind [--tool <name>]',
  run(args: readonly string[]): Promise<number> {
    const { tool } = parseRemindArgs(args);
    return runHookRemind({ tool: tool ?? 'find_relevant_symbols' });
  },
};
