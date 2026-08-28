import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FAST_CLASSIFIER_MODEL,
  buildFastClassifierModelfile,
} from './modelfile';

const execFile = promisify(execFileCb);

/** Default classifier model pulled by `init` when Ollama is reachable. */
export const OLLAMA_MODEL = 'qwen3:1.7b';

/**
 * Windows release-zip asset URLs (verified against each project's latest
 * GitHub release). These are the documented Windows install path
 * (docs/requirements.md).
 */
export const RTK_WINDOWS_URL =
  'https://github.com/rtk-ai/rtk/releases/latest/download/rtk-x86_64-pc-windows-msvc.zip';
export const LEANCTX_WINDOWS_URL =
  'https://github.com/yvgude/lean-ctx/releases/latest/download/lean-ctx-x86_64-pc-windows-msvc.zip';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

async function run(bin: string, args: readonly string[]): Promise<CommandResult> {
  return execFile(bin, [...args], { timeout: 300_000 });
}

/** Consent-gated: `ollama pull <model>` — safe and idempotent. */
export async function pullOllamaModel(
  model = OLLAMA_MODEL,
): Promise<CommandResult> {
  return run('ollama', ['pull', model]);
}

/**
 * Build the Modelfile-derived fast classifier: `ollama create
 * fast-classifier -f <Modelfile>`. Requires the base model to already be
 * pulled. Writes the Modelfile to a temp file so it does not pollute the cwd.
 */
export async function createFastClassifier(
  base = OLLAMA_MODEL,
): Promise<CommandResult> {
  const modelfilePath = join(
    tmpdir(),
    `fast-classifier-${Date.now()}.Modelfile`,
  );
  writeFileSync(modelfilePath, buildFastClassifierModelfile(base), 'utf8');
  try {
    return await run('ollama', [
      'create',
      FAST_CLASSIFIER_MODEL,
      '-f',
      modelfilePath,
    ]);
  } finally {
    rmSync(modelfilePath, { force: true });
  }
}

/** Consent-gated: start the documented Ollama Docker container (design doc §1). */
export async function startOllamaDocker(): Promise<CommandResult> {
  return run('docker', [
    'run',
    '-d',
    '--name',
    'ollama',
    '-v',
    'ollama:/root/.ollama',
    '-p',
    '11434:11434',
    '--restart',
    'unless-stopped',
    'ollama/ollama',
  ]);
}

export interface DownloadResult {
  ok: boolean;
  error?: string;
  /** Absolute path to the extracted executable. */
  binPath?: string;
}

/**
 * Download a Windows release zip and extract it into `destDir`.
 * Extraction tries `tar -xf` (bsdtar, ships with Windows 10+) then `unzip`
 * (Git Bash / Linux). Never overwrites an existing binary. Returns `ok: false`
 * (never throws) so callers can fall back to printed manual instructions.
 */
export async function downloadAndExtractZip(
  url: string,
  destDir: string,
  binName: string,
): Promise<DownloadResult> {
  const exeName = process.platform === 'win32' ? `${binName}.exe` : binName;
  const binPath = join(destDir, exeName);
  if (existsSync(binPath)) {
    return { ok: true, binPath };
  }
  try {
    mkdirSync(destDir, { recursive: true });
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `download failed (HTTP ${response.status})` };
    }
    const zipPath = join(destDir, `${binName}.zip`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    try {
      await run('tar', ['-xf', zipPath, '-C', destDir]);
    } catch {
      await run('unzip', ['-o', zipPath, '-d', destDir]);
    }
    rmSync(zipPath, { force: true });
    if (!existsSync(binPath)) {
      return { ok: false, error: `archive did not contain ${exeName}` };
    }
    return { ok: true, binPath };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
