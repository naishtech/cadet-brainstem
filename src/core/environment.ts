import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_OLLAMA_HOST, isOllamaAvailable } from '../classifier';
import { LeanCtxAdapter } from '../integrations/leanctx';
import { LEAN_CTX_BIN } from '../integrations/leanctx/adapter';
import { RtkAdapter } from '../integrations/rtk';
import { RTK_BIN } from '../integrations/rtk/adapter';
import { SerenaAdapter } from '../integrations/serena';
import { SERENA_BIN } from '../integrations/serena/adapter';
import type { ContextOptimizer } from './context-optimizer';

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

export type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

export interface ToolAvailability {
  name: string;
  available: boolean;
  /** Version or a short reachability note when available. */
  detail?: string;
}

export interface EnvironmentReport {
  platform: Platform;
  node: ToolAvailability;
  npm: ToolAvailability;
  ollama: ToolAvailability;
  rtk: ToolAvailability;
  serena: ToolAvailability;
  leanctx: ToolAvailability;
  /** Integration tools (rtk/serena/leanctx) that are installed & reachable. */
  availableTools: string[];
  /** Integration tools that are missing. */
  missingTools: string[];
}

export function detectPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

/** Strip trailing parenthetical URL noise from a `--version` line (e.g. lean-ctx). */
function cleanVersion(line: string): string {
  return line.replace(/\s*\([^)]*https?:\/\/[^)]*\)/gi, '').trim();
}

/**
 * Best-effort `<bin> --version`; undefined when it cannot be read.
 * `shell` is required on Windows for `.cmd` shims (e.g. npm) — execFile
 * cannot launch them without it. Uses `exec` (string command) for the shell
 * path to avoid Node's args-with-shell deprecation warning; the binary name
 * is a fixed constant, never user input.
 */
async function getVersion(bin: string, shell = false): Promise<string | undefined> {
  try {
    const { stdout } = shell
      ? await exec(`${bin} --version`, { timeout: 5_000 })
      : await execFile(bin, ['--version'], { timeout: 5_000 });
    const line = stdout.split('\n')[0]?.trim();
    return line !== undefined && line.length > 0 ? cleanVersion(line) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map adapter names to the CLI binary that reports their version. Some adapters'
 * `name` differs from their binary (LeanCTX is `leanctx` but its CLI is
 * `lean-ctx`), so probing `<name> --version` would miss the version.
 */
const VERSION_BIN: Record<string, string> = {
  leanctx: LEAN_CTX_BIN,
  rtk: RTK_BIN,
  serena: SERENA_BIN,
};

async function detectTool(adapter: ContextOptimizer): Promise<ToolAvailability> {
  const available = await adapter.isAvailable();
  const bin = VERSION_BIN[adapter.name] ?? adapter.name;
  const detail = available ? await getVersion(bin) : undefined;
  return {
    name: adapter.name,
    available,
    ...(detail !== undefined ? { detail } : {}),
  };
}

async function detectNode(): Promise<ToolAvailability> {
  return { name: 'node', available: true, detail: process.versions.node };
}

async function detectNpm(): Promise<ToolAvailability> {
  // On Windows npm is a `npm.cmd` shim — launch via the shell.
  const version = await getVersion('npm', process.platform === 'win32');
  return {
    name: 'npm',
    available: version !== undefined,
    ...(version !== undefined ? { detail: version } : {}),
  };
}

async function detectOllama(host: string): Promise<ToolAvailability> {
  const available = await isOllamaAvailable(host);
  return {
    name: 'ollama',
    available,
    ...(available ? { detail: host } : {}),
  };
}

/**
 * Detect the environment: OS, Node/npm, Ollama and each integration tool.
 * Reuses the integration adapters' `isAvailable()` (design doc §1, Tasks 08–10)
 * so the report stays consistent with what the pipeline actually uses.
 */
export async function detectEnvironment(
  host = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
): Promise<EnvironmentReport> {
  const platform = detectPlatform();
  const [node, npm, ollama, rtk, serena, leanctx] = await Promise.all([
    detectNode(),
    detectNpm(),
    detectOllama(host),
    detectTool(new RtkAdapter()),
    detectTool(new SerenaAdapter()),
    detectTool(new LeanCtxAdapter()),
  ]);

  const tools = [rtk, serena, leanctx];
  const availableTools = tools
    .filter((tool) => tool.available)
    .map((tool) => tool.name);
  const missingTools = tools
    .filter((tool) => !tool.available)
    .map((tool) => tool.name);

  return {
    platform,
    node,
    npm,
    ollama,
    rtk,
    serena,
    leanctx,
    availableTools,
    missingTools,
  };
}
