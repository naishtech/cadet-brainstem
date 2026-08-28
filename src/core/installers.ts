import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { isModelAvailable } from '../classifier';
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

export interface CreateFastClassifierResult {
  ok: boolean;
  error?: string;
}

/**
 * Build the Modelfile-derived fast classifier so its SYSTEM block is actually
 * baked in.
 *
 * Deliberately does NOT use Ollama's HTTP `/api/create` with `from`+`modelfile`:
 * that path silently drops the SYSTEM/params directives and yields a
 * SYSTEM-less (broken) classifier — the deployed-model bug we hit. Instead this
 * uses the `ollama create` CLI (which correctly applies SYSTEM) via the host
 * binary, or via `docker exec` when Ollama runs in a container and `ollama` is
 * not on PATH. After building it VERIFIES the model is present and that its
 * SYSTEM is active, returning `ok:false` with a clear error rather than silently
 * leaving a broken classifier. Never throws.
 */
export async function createFastClassifierCli(
  base = OLLAMA_MODEL,
  host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
): Promise<CreateFastClassifierResult> {
  const modelfilePath = join(
    tmpdir(),
    `fast-classifier-${Date.now()}.Modelfile`,
  );
  writeFileSync(modelfilePath, buildFastClassifierModelfile(base), 'utf8');
  try {
    const buildError = await buildViaCli(modelfilePath);
    if (buildError !== undefined) {
      return { ok: false, error: buildError };
    }
    if (!(await isModelAvailable(FAST_CLASSIFIER_MODEL, host))) {
      return {
        ok: false,
        error: 'build reported success but the fast-classifier model is not present',
      };
    }
    if (!(await verifyClassifierSystem(FAST_CLASSIFIER_MODEL, host))) {
      return {
        ok: false,
        error:
          'build did not bake the SYSTEM block (would be a broken classifier); refusing to use it',
      };
    }
    return { ok: true };
  } finally {
    rmSync(modelfilePath, { force: true });
  }
}

/**
 * Run `ollama create fast-classifier -f <Modelfile>`, preferring the host
 * `ollama` binary and falling back to the documented Ollama Docker container
 * (`docker cp` + `docker exec ollama ollama create`) when `ollama` is not on
 * PATH. Returns an error string on failure, or undefined on success.
 */
async function buildViaCli(modelfilePath: string): Promise<string | undefined> {
  try {
    await run('ollama', [
      'create',
      FAST_CLASSIFIER_MODEL,
      '-f',
      modelfilePath,
    ]);
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `ollama create failed: ${(err as Error).message}`;
    }
  }
  // `ollama` not on PATH — try the documented Ollama container (name `ollama`).
  const remote = `/tmp/${basename(modelfilePath)}`;
  try {
    await run('docker', ['cp', modelfilePath, `ollama:${remote}`]);
    try {
      await run('docker', [
        'exec',
        'ollama',
        'ollama',
        'create',
        FAST_CLASSIFIER_MODEL,
        '-f',
        remote,
      ]);
      return undefined;
    } finally {
      try {
        await run('docker', ['exec', 'ollama', 'rm', '-f', remote]);
      } catch {
        // best-effort cleanup
      }
    }
  } catch (err) {
    return `no ollama CLI and docker fallback failed: ${(err as Error).message}`;
  }
}

/**
 * Best-effort probe that a model actually behaves as a classifier (i.e. its
 * SYSTEM block is active). A SYSTEM-less base model answers a classify request
 * literally (e.g. "You cannot merge..."); a SYSTEM-ful one emits a routing
 * classification that mentions `task`. Used to refuse a silently-broken build.
 */
async function verifyClassifierSystem(
  model: string,
  host: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content:
              'Return a JSON routing strategy for this request: merge the open PR on the auth branch',
          },
        ],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 150 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? '';
    // A SYSTEM-ful classifier emits JSON with these classifier-specific fields
    // (response_policy / reminders appear before task due to token-saving field
    // order, so check the whole family). A SYSTEM-less base model answers
    // literally and would contain none of them.
    return /task|response_policy|reminders|tool_plan|context_need|evidence_plan/.test(
      content,
    );
  } catch {
    return false;
  }
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
