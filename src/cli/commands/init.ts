import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DEFAULT_OLLAMA_HOST, isModelAvailable } from '../../classifier';
import { getConfigPath, loadConfig, saveConfig } from '../../config';
import {
  detectEnvironment,
  type EnvironmentReport,
  type ToolAvailability,
} from '../../core/environment';
import { INIT_BANNER } from '../banner';
import {
  LEANCTX_WINDOWS_URL,
  RTK_WINDOWS_URL,
  createFastClassifier,
  downloadAndExtractZip,
  pullOllamaModel,
  startOllamaDocker,
} from '../../core/installers';
import { FAST_CLASSIFIER_MODEL } from '../../core/modelfile';
import { getDefaultMetricsPath, MetricsStore } from '../../metrics';
import type { CliCommand } from '../types';

export interface InitDeps {
  /** Override environment detection (tests). */
  detect?: () => Promise<EnvironmentReport>;
  /** Consent prompt. Defaults to interactive y/N. */
  ask?: (question: string) => Promise<boolean>;
  /** Override where the config is written (tests). */
  configPath?: string;
  /** Override where the metrics db is created (tests). */
  metricsPath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
}

/**
 * Default consent prompt: read a y/N answer from stdin. When stdin is not a
 * TTY (pipelines, CI, redirected fd) or the terminal refuses raw mode, no
 * answer is possible — the question is printed and "no" is assumed so the
 * tool never modifies the environment unasked.
 */
export async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${question} [y/N] (non-interactive — assuming no)`);
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } catch {
    // e.g. "stdin is not a tty" from setRawMode on a console handle that is
    // not a real TTY (common in Git Bash on Windows) — assume no.
    console.log(`${question} [y/N] (cannot read a response — assuming no)`);
    return false;
  } finally {
    rl.close();
  }
}

function formatAvailability(tool: ToolAvailability): string {
  if (tool.available) {
    return tool.detail !== undefined ? tool.detail : 'available';
  }
  return 'MISSING';
}

interface OfferContext {
  ask: (question: string) => Promise<boolean>;
  log: (line: string) => void;
  model: string;
  host: string;
}

/** Consent-gated offers to configure/install missing pieces (design doc §1.8). */
async function offerInstallations(
  report: EnvironmentReport,
  { ask, log, model, host }: OfferContext,
): Promise<void> {
  // Classifier model — only offer to pull when Ollama is reachable AND the
  // model is not already present (idempotent, no redundant prompts).
  if (report.ollama.available) {
    const modelOk = await isModelAvailable(model, host);
    if (modelOk) {
      log(`Classifier model ${model} already present — nothing to pull.`);
    } else if (await ask(`Pull the classifier model (${model}) via Ollama?`)) {
      try {
        const { stdout, stderr } = await pullOllamaModel(model);
        log(stdout || stderr);
      } catch (err) {
        log(`  failed: ${(err as Error).message}`);
      }
    }
  } else {
    log('');
    log('Missing: ollama (classifier)');
    log('  Native install: https://ollama.com');
    log(
      '  Docker: docker run -d --name ollama -v ollama:/root/.ollama -p 11434:11434 --restart unless-stopped ollama/ollama',
    );
    if (await ask('Start Ollama via Docker (if Docker is installed)?')) {
      try {
        const { stdout, stderr } = await startOllamaDocker();
        log(stdout || stderr);
      } catch (err) {
        log(`  failed: ${(err as Error).message}`);
      }
    }
  }

  // Build the Modelfile-derived fast classifier once the base is present.
  // Runtime calls use this derived model (config `derived_model`), whose static
  // instructions live in the SYSTEM block — so each request sends only the
  // user's text. Requires `ollama create`, only offered when Ollama is up.
  if (report.ollama.available) {
    const derivedOk = await isModelAvailable(FAST_CLASSIFIER_MODEL, host);
    if (derivedOk) {
      log(`Fast classifier ${FAST_CLASSIFIER_MODEL} already present.`);
    } else if (
      await ask(
        `Build the fast classifier (${FAST_CLASSIFIER_MODEL}) from the Modelfile via Ollama?`,
      )
    ) {
      try {
        const { stdout, stderr } = await createFastClassifier();
        log(stdout || stderr);
      } catch (err) {
        log(`  failed: ${(err as Error).message}`);
        log('  You can build it later with: ollama create fast-classifier -f Modelfile');
      }
    }
  }

  for (const tool of report.missingTools) {
    log('');
    log(`Missing: ${tool}`);
    if (tool === 'rtk' || tool === 'leanctx') {
      const url = tool === 'rtk' ? RTK_WINDOWS_URL : LEANCTX_WINDOWS_URL;
      const repoUrl =
        tool === 'rtk'
          ? 'https://github.com/rtk-ai/rtk/releases'
          : 'https://github.com/yvgude/lean-ctx/releases';
      const binDir = join(os.homedir(), '.local', 'bin');
      log(
        `  Manual: download the Windows release zip from ${repoUrl} and extract it to ${binDir}.`,
      );
      if (report.platform === 'windows') {
        if (await ask(`Download and install ${tool} into ${binDir}?`)) {
          const result = await downloadAndExtractZip(url, binDir, tool);
          if (result.ok) {
            log(
              `  Installed ${tool} -> ${result.binPath}. Add ${binDir} to your PATH if needed.`,
            );
          } else {
            log(
              `  Auto-install failed (${result.error ?? 'unknown error'}). Install manually from ${repoUrl}.`,
            );
          }
        }
      }
    } else if (tool === 'serena') {
      log('  Install per its own documentation, then verify with: serena --version');
    }
  }
}

/**
 * Primary first-run experience (design doc §1, Task 14): detect the
 * environment, create the config + metrics store, and offer consent-gated
 * installs. Safe to run repeatedly — existing config is never clobbered.
 */
export async function runInit(deps: InitDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = deps.ask ?? askYesNo;
  const detect = deps.detect ?? detectEnvironment;

  const report = await detect();

  // 1. Banner + report what is available.
  log('');
  log(INIT_BANNER);
  log('');
  log('[cadet-brainstem] init — environment report');
  log('--------------------------------------------');
  log(`Platform: ${report.platform}`);
  log(`Node:     ${formatAvailability(report.node)}`);
  log(`npm:      ${formatAvailability(report.npm)}`);
  log(`Ollama:   ${formatAvailability(report.ollama)}`);
  log(`RTK:      ${formatAvailability(report.rtk)}`);
  log(`Serena:   ${formatAvailability(report.serena)}`);
  log(`LeanCTX:  ${formatAvailability(report.leanctx)}`);
  log('');

  // 2. Create the config (idempotent — never clobber an existing file).
  const configPath = deps.configPath ?? getConfigPath();
  if (existsSync(configPath)) {
    log(`[cadet-brainstem] config already exists (unchanged): ${configPath}`);
  } else {
    saveConfig(loadConfig(configPath), configPath);
    log(`[cadet-brainstem] config created: ${configPath}`);
  }

  // 3. Initialise the metrics database (idempotent — CREATE TABLE IF NOT EXISTS).
  const metricsPath = deps.metricsPath ?? getDefaultMetricsPath();
  const store = new MetricsStore(metricsPath);
  store.close();
  log(`[cadet-brainstem] metrics database ready: ${metricsPath}`);

  // 4. Consent-gated configuration/installation of missing pieces.
  const model = loadConfig(configPath).classifier.model;
  const host = process.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
  await offerInstallations(report, { ask, log, model, host });

  // 5. Summary.
  log('');
  log('[cadet-brainstem] init complete.');
  log(`  Tools available: ${report.availableTools.join(', ') || '(none)'}`);
  if (report.missingTools.length > 0) {
    log(`  Tools missing:   ${report.missingTools.join(', ')}`);
    log('  Run "cadet-brainstem doctor" for details.');
  }

  // 6. IDE / MCP wiring hint.
  log('');
  log('Connect your IDE to the MCP server:');
  log('Add this to .vscode/mcp.json in your project, then reload the window:');
  log('');
  log('{');
  log('  "servers": {');
  log('    "cadet-brainstem": {');
  log('      "type": "stdio",');
  log('      "command": "cadet-brainstem",');
  log('      "args": ["mcp"]');
  log('    }');
  log('  }');
  log('}');
  log('');
  log('The "cadet-brainstem" MCP server will then appear in Copilot Chat,');
  log('exposing classify, optimize_context, find_relevant_symbols, compress_command_output and chat_memory_store.');
  log('Docs: https://github.com/naishtech/cadet-brainstem/blob/main/docs/integration-vscode.md');
  log('');
  log('Tell your agent how to use it (paste into your agent prompts / AGENTS.md):');
  log('  "For every user request, before doing anything else, call the `classify` tool once');
  log('   with a short, faithful restatement of the request — not the verbatim message. It');
  log('   runs the local LLM and returns the recommended strategy plus a `response_policy`');
  log('   and a `memory_policy`; parse and follow both in every reply. Then use the Cadet');
  log('   Brainstem tools to save context: call optimize_context before reading a large');
  log('   file; use find_relevant_symbols before broad searches; call compress_command_output');
  log('   for noisy command output (pass "shell": "bash" if you are in git-bash on Windows).');
  log('   Use chat_memory_store to check memory before starting work and to store facts that');
  log('   are expensive to rediscover; never store secrets. If a tool is unavailable, fall');
  log('   back to the normal read."');
  log('');
  log('Notes: commands run in the platform shell (cmd.exe on Windows) unless a shell is');
  log('specified; compression only helps on large/noisy output — small output is pass-through.');
  log('Design: https://github.com/naishtech/cadet-brainstem/blob/main/docs/plans/initial_design.md');
  return 0;
}

export const initCommand: CliCommand = {
  name: 'init',
  description: 'Set up configuration and integrations (first run)',
  usage: 'cadet-brainstem init',
  run(): Promise<number> {
    return runInit();
  },
};

