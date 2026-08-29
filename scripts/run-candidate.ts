/**
 * Run one curated candidate through the LOCAL LLM and report pass/fail.
 *
 * For each step the local LLM drives the relevant tool: RTK steps are executed
 * for real (compress_command_output via RtkAdapter); LeanCTX steps are executed
 * (ctx_read/ctx_explore); Serena edit steps are reported as intended write
 * actions (not auto-executed — they are requires_review). The LLM then gives a
 * final report and a self-assessed pass/fail.
 *
 * Usage:
 *   npx tsx scripts/run-candidate.ts <path-to-candidate.json>
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFileSync, cpSync } from 'node:fs';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { resolveBaseModel } from '../src/classifier';
import { RtkAdapter } from '../src/integrations/rtk';
import { LeanCtxAdapter } from '../src/integrations/leanctx';
import { SerenaAdapter } from '../src/integrations/serena';

const execFileP = promisify(execFile);
const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const SANDBOX_ROOT = join('test', 'artifacts');

interface CandidateStep {
  service: string;
  tool: string;
  args?: Record<string, unknown>;
}

interface Candidate {
  id: string;
  trigger_pattern: string;
  keywords: string[];
  goal?: string;
  context?: string;
  constraints?: string[];
  steps: CandidateStep[];
  source_conversation_id: string;
  difficulty: string;
  fixture?: string;
  pass_fail?: PassFail;
  tool_template?: { service?: string; tool?: string; syntax?: string };
}

/** Objective check spec — evaluated in Node (cross-platform, no shell). */
interface PassFail {
  type?: 'file_exists' | 'glob_exists' | 'contains' | 'excludes' | 'all_exist' | 'shell' | 'step_ok';
  path?: string;
  needle?: string;
  needles?: string[];
  paths?: string[];
  command?: string;
  expected?: string;
}

/**
 * Objective pass/fail, evaluated in Node (not shell) so it works identically on
 * Windows and POSIX. Never relies on the LLM's self-assessment.
 */
async function objectiveCheck(candidate: Candidate, cwd: string, stepFailed: boolean): Promise<{ passed: boolean; output: string }> {
  const pf = candidate.pass_fail;
  if (!pf || !pf.type) {
    return { passed: false, output: '(no objective pass_fail defined)' };
  }
  try {
    switch (pf.type) {
      case 'file_exists': {
        const p = join(cwd, pf.path ?? '');
        return { passed: existsSync(p), output: `${pf.path} exists: ${existsSync(p)}` };
      }
      case 'glob_exists': {
        const pattern = pf.path ?? '*';
        const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
        const files = readdirSync(cwd);
        const matches = ext ? files.filter((f) => f.endsWith(ext)) : files;
        return { passed: matches.length > 0, output: `matching files: ${matches.length}` };
      }
      case 'contains': {
        const p = join(cwd, pf.path ?? '');
        if (!existsSync(p)) return { passed: false, output: `file missing: ${pf.path}` };
        const content = readFileSync(p, 'utf8');
        return { passed: content.includes(pf.needle ?? ''), output: `contains "${pf.needle}"` };
      }
      case 'excludes': {
        const p = join(cwd, pf.path ?? '');
        if (!existsSync(p)) return { passed: false, output: `file missing: ${pf.path}` };
        const content = readFileSync(p, 'utf8');
        const needles = pf.needles ?? (pf.needle ? [pf.needle] : []);
        const found = needles.filter((n) => content.includes(n));
        return { passed: found.length === 0, output: found.length > 0 ? `still contains: ${found.join(', ')}` : 'no needles present' };
      }
      case 'all_exist': {
        const paths = pf.paths ?? [];
        const missing = paths.filter((p) => !existsSync(join(cwd, p)));
        return { passed: missing.length === 0, output: missing.length > 0 ? `missing: ${missing.join(', ')}` : 'all paths present' };
      }
      case 'shell': {
        try {
          const { stdout } = await execFileP(pf.command ?? '', { cwd, shell: true, timeout: 30_000 });
          return { passed: true, output: (stdout ?? '').trim() || '(exit 0)' };
        } catch (err) {
          const e = err as { stderr?: string; code?: number };
          return { passed: false, output: (e.stderr ?? '').trim() || `(exit ${e.code})` };
        }
      }
      case 'step_ok': {
        return { passed: !stepFailed, output: stepFailed ? 'a step failed' : 'all steps executed without error' };
      }
      default:
        return { passed: false, output: `unknown check type: ${pf.type}` };
    }
  } catch (err) {
    return { passed: false, output: `check error: ${(err as Error).message}` };
  }
}

async function llmJson(prompt: string, schema: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolveBaseModel(),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: schema,
      think: false,
      options: { temperature: 0, num_predict: 800 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return JSON.parse(data.message?.content ?? '{}') as Record<string, unknown>;
}

async function runRtkStep(step: CandidateStep, cwd: string): Promise<string> {
  const plan = (await llmJson(
    [
      `You have a tool "rtk" that runs a shell command and returns its output.`,
      `The working directory (artifact dir) is: ${cwd}`,
      `Task: ${step.tool} (${JSON.stringify(step.args ?? {})}).`,
      `Choose a concrete shell command. Respond with JSON: {"command": "<command>"}.`,
    ].join('\n'),
    { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  )) as { command?: string };
  if (!plan.command) return '(no command proposed)';
  const rtk = new RtkAdapter();
  const result = await rtk.optimize({ command: plan.command, cwd });
  return result.optimisedOutput || result.rawOutput;
}

async function runLeanStep(step: CandidateStep): Promise<string> {
  const adapter = new LeanCtxAdapter();
  const result = await adapter.optimize({
    target: '.',
    mode: 'map',
    taskType: 'investigation',
    ...(typeof step.args?.target === 'string' ? { target: step.args.target as string } : {}),
  });
  return result.context.slice(0, 2000);
}

/**
 * Execute a real LeanCTX tool call with parameters filled by the local LLM,
 * mirroring the Serena template-driven path. LeanCTX paths are absolute or
 * resolved relative to the session cwd, so args are passed through verbatim
 * (no basename normalization).
 */
async function runLeanToolStep(
  step: CandidateStep,
  cwd: string,
  adapter: LeanCtxAdapter,
  template?: { tool?: string; syntax?: string },
  intent?: { goal?: string; context?: string; constraints?: string[]; args?: Record<string, unknown> },
): Promise<string> {
  const tool = template?.tool ?? step.tool;
  const syntax = template?.syntax ?? `{ <parameters for ${tool}> }`;
  const intended = intent?.args && Object.keys(intent.args).length > 0 ? JSON.stringify(intent.args) : '';
  const plan = (await llmJson(
    [
      `Task: ${intent?.goal ?? step.tool}`,
      intent?.context ? `Context: ${intent.context}` : '',
      intent?.constraints?.length ? `Constraints:\n${intent.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      intended ? `The intended parameter values are: ${intended}. Fill the tool's parameters using exactly these values.` : '',
      `You must call the LeanCTX tool "${tool}".`,
      `LeanCTX ${tool} syntax: ${syntax}`,
      `The project working directory is: ${cwd}`,
      `Return ONLY the fields named in the syntax — no extra fields.`,
      `Fill in the parameters. Respond with JSON: {"arguments": {<parameters>}}.`,
    ].filter(Boolean).join('\n'),
    { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'] },
  )) as { arguments?: Record<string, unknown> };
  if (!plan.arguments) return '(no arguments proposed)';
  const result = await adapter.callTool({ tool, arguments: plan.arguments, cwd });
  return `${result.rawText}\nDEGRADED: ${result.degraded}`.slice(0, 1200);
}

/**
 * Execute a Serena write step inside the sandbox (safe — the sandbox is a
 * scratch dir, cleaned after the run). The LLM supplies the file path + content.
 */
/**
 * Execute a real Serena tool call with parameters filled by the local LLM,
 * working backwards from the tool's known syntax. Runs against the registered
 * sandbox project via the Serena MCP adapter.
 */
async function runSerenaToolStep(
  step: CandidateStep,
  sandbox: string,
  adapter: SerenaAdapter,
  template?: { tool?: string; syntax?: string },
  expectedPath?: string,
  intent?: { goal?: string; context?: string; constraints?: string[]; args?: Record<string, unknown> },
): Promise<string> {
  const tool = template?.tool ?? step.tool;
  const syntax = template?.syntax ?? `{ <parameters for ${tool}> }`;
  // Read-only tools need a real existing path, so show the model what's there.
  const readOnly = tool === 'read_file' || tool === 'read_files' || tool === 'list_files';
  const listing = readOnly ? listTree(sandbox) : '';
  const intended = intent?.args && Object.keys(intent.args).length > 0 ? JSON.stringify(intent.args) : '';
  const plan = (await llmJson(
    [
      `Task: ${intent?.goal ?? step.tool}`,
      intent?.context ? `Context: ${intent.context}` : '',
      intent?.constraints?.length ? `Constraints:\n${intent.constraints.map((c) => `- ${c}`).join('\n')}` : '',
      intended ? `The intended parameter values are: ${intended}. Fill the tool's parameters using exactly these values.` : '',
      `You must call the Serena tool "${tool}" on the registered Serena project.`,
      `Serena ${tool} syntax: ${syntax}`,
      expectedPath ? `The expected output file is "${expectedPath}". Name the file exactly that.` : '',
      readOnly ? `Available files in the project (relative paths):\n${listing}\nIf the task needs an existing file, choose its exact relative path from this list.` : '',
      `Rules: the path field must be a RELATIVE path within the project (e.g. "hello.txt" or "src/Program.cs"). No drive letter, no leading/trailing slashes.`,      `Do NOT shorten or trim directory prefixes from paths — use the full relative path exactly as given (e.g. 'src/main.cpp', never just 'main.cpp').`,      `Return ONLY the fields named in the syntax — no extra fields.`,
      `Fill in the parameters. Respond with JSON: {"arguments": {<parameters>}}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'] },
  )) as { arguments?: Record<string, unknown> };
  if (!plan.arguments) return '(no arguments proposed)';
  // Normalize path-like fields to a clean RELATIVE path (strip drive letter and
  // leading slashes) but never force a basename — many tools take nested
  // relative paths like "src/main.cpp" and forcing basename corrupts them.
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan.arguments)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    let k = key;
    // create_text_file expects "relative_path", not "file".
    if (tool === 'create_text_file' && key === 'file') k = 'relative_path';
    if (k === 'file' || k === 'path' || k === 'file_name' || k === 'relative_path') {
      normalized[k] = String(value).replace(/^[A-Za-z]:[\\/]/, '').replace(/^[\\/]+/, '');
    } else {
      normalized[k] = value;
    }
  }
  const result = await adapter.callTool({ tool, arguments: normalized, cwd: sandbox });
  return `${result.rawText}\nSTRUCTURED: ${JSON.stringify(result.result)}`.slice(0, 1200);
}

/** Recursively list files in a dir as POSIX-style relative paths. */
function listTree(dir: string, prefix = ''): string {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listTree(full, rel));
    else out.push(rel);
  }
  return out.join('\n');
}

/**
 * Execute a Serena write/edit step inside the sandbox. If a fixture file
 * exists there, present its content and ask the LLM for the edited version
 * (replace_lines); otherwise ask it to create a new file.
 */
async function runSerenaWriteStep(step: CandidateStep, sandbox: string, expectedPath?: string): Promise<string> {
  const existing = readdirSync(sandbox).filter((f) => !f.startsWith('.'));
  if (existing.length > 0) {
    const target = basename(existing[0]!);
    const current = readFileSync(join(sandbox, target), 'utf8');
    const outputName =
      expectedPath && !expectedPath.includes('*') ? expectedPath : undefined;
    const plan = (await llmJson(
      [
        `You must perform a write/edit action: ${step.tool} on the file ${target}.`,
        `Working directory (artifact dir): ${sandbox}`,
        outputName
          ? `The expected output file is "${outputName}". Your "file" value MUST be exactly that path.`
          : '',
        `Here is the CURRENT content of ${target}:`,
        `"""`,
        current,
        `"""`,
        `Return the FULL edited content of ${target} (replace_lines). Respond with JSON:`,
        `{"file": "${outputName ?? target}", "content": "<full edited content>"}.`,
      ].join('\n'),
      { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] },
    )) as { file?: string; content?: string };
    const name = plan.file ?? target;
    const outFile = outputName ?? basename(name);
    writeFileSync(join(sandbox, outFile), plan.content ?? '', 'utf8');
    return `edited ${outFile} (${(plan.content ?? '').length} chars)`;
  }
  // No existing file — create a new one.
  const expected = expectedPath ? `The expected output file is "${expectedPath}". Your "file" value MUST be exactly that path.` : '';
  const plan = (await llmJson(
    [
      `You must perform a write action: ${step.tool}.`,
      `Write files RELATIVE to the current artifact directory: ${sandbox}`,
      expected.length > 0 ? expected : 'Choose an appropriate file path.',
      `Respond with JSON: {"file": "<relative file path>", "content": "<full file content>"}.`,
    ].join('\n'),
    { type: 'object', properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] },
  )) as { file?: string; content?: string };
  if (!plan.file) return '(no file proposed)';
  const abs = join(sandbox, basename(plan.file));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, plan.content ?? '', 'utf8');
  return `wrote ${basename(plan.file)} (${(plan.content ?? '').length} chars)`;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx scripts/run-candidate.ts <candidate.json>');
    process.exit(1);
  }
  const candidate = JSON.parse(readFileSync(file, 'utf8')) as Candidate;
  const sandbox = join(SANDBOX_ROOT, candidate.id);
  mkdirSync(sandbox, { recursive: true });
  // Fresh git repo in the sandbox so RTK git steps and write steps are isolated.
  await execFileP('git', ['init', '-q'], { cwd: sandbox }).catch(() => undefined);
  // Copy the candidate's input fixture into the sandbox (file or directory).
  // For directories, copy the CONTENTS into the sandbox root so relative paths
  // stay natural (e.g. a fixture with src/Program.cs lands at src/Program.cs).
  if (candidate.fixture && existsSync(candidate.fixture)) {
    if (statSync(candidate.fixture).isDirectory()) {
      for (const entry of readdirSync(candidate.fixture)) {
        if (entry.startsWith('.')) continue;
        cpSync(join(candidate.fixture, entry), join(sandbox, entry), { recursive: true });
      }
      console.log('fixture dir copied:', candidate.fixture);
    } else {
      copyFileSync(candidate.fixture, join(sandbox, basename(candidate.fixture)));
      console.log('fixture copied:', candidate.fixture);
    }
  }

  console.log(`Candidate ${candidate.id}: ${candidate.trigger_pattern} [${candidate.difficulty}]`);
  console.log(`sandbox: ${sandbox}`);
  if (candidate.goal) console.log(`goal: ${candidate.goal}`);
  if (candidate.context) console.log(`context: ${candidate.context}`);
  if (candidate.constraints?.length) console.log(`constraints: ${candidate.constraints.join('; ')}`);
  console.log(`steps: ${candidate.steps.map((s) => `${s.service}:${s.tool}`).join(' -> ')}`);

  // Register the sandbox as a Serena project (needs C++/C# files to index).
  // Use ONE shared adapter so the same Serena session/server is reused.
  const serenaAdapter = candidate.steps.some((s) => s.service === 'serena') ? new SerenaAdapter() : null;
  if (serenaAdapter) {
    try {
      const act = await serenaAdapter.callTool({
        tool: 'activate_project',
        arguments: { project: join(process.cwd(), sandbox) },
        cwd: sandbox,
      });
      console.log('serena activate_project:', (act.rawText || act.result || '').toString().slice(0, 200));
    } catch (err) {
      console.log('serena activate_project failed:', (err as Error).message);
    }
  }
  // Shared LeanCtxAdapter for template-driven leanctx steps (reuse one MCP session).
  const leanAdapter = candidate.tool_template?.service === 'leanctx' ? new LeanCtxAdapter() : null;

  let stepFailed = false;
  for (const step of candidate.steps) {
    process.stdout.write(`\n-- step ${step.service}:${step.tool} --\n`);
    try {
      if (step.service === 'rtk') {
        const out = await runRtkStep(step, sandbox);
        console.log('output:', out.slice(0, 500));
      } else if (step.service === 'leanctx' && leanAdapter && candidate.tool_template?.tool) {
        // Template-driven: real LeanCTX tool call with LLM-filled parameters.
        const out = await runLeanToolStep(step, sandbox, leanAdapter, candidate.tool_template, {
          ...(candidate.goal !== undefined ? { goal: candidate.goal } : {}),
          ...(candidate.context !== undefined ? { context: candidate.context } : {}),
          ...(candidate.constraints !== undefined ? { constraints: candidate.constraints } : {}),
          ...(step.args !== undefined && Object.keys(step.args).length > 0 ? { args: step.args } : {}),
        });
        console.log('output:', out.slice(0, 600));
        if (/Error executing tool|DEGRADED: true/.test(out)) stepFailed = true;
      } else if (step.service === 'leanctx') {
        const out = await runLeanStep(step);
        console.log('output:', out.slice(0, 300));
      } else if (step.service === 'serena' && serenaAdapter && candidate.tool_template?.tool) {
        // Template-driven: real Serena tool call with LLM-filled parameters.
        const out = await runSerenaToolStep(step, sandbox, serenaAdapter, candidate.tool_template, candidate.pass_fail?.path, {
          ...(candidate.goal !== undefined ? { goal: candidate.goal } : {}),
          ...(candidate.context !== undefined ? { context: candidate.context } : {}),
          ...(candidate.constraints !== undefined ? { constraints: candidate.constraints } : {}),
          ...(step.args !== undefined && Object.keys(step.args).length > 0 ? { args: step.args } : {}),
        });
        console.log('output:', out.slice(0, 800));
        if (/Error executing tool/.test(out)) stepFailed = true;
      } else {
        // Serena write action — executed safely inside the sandbox.
        const out = await runSerenaWriteStep(step, sandbox, candidate.pass_fail?.path);
        console.log('output:', out);
      }
    } catch (err) {
      stepFailed = true;
      console.log(`step failed: ${(err as Error).message}`);
    }
  }

  // Objective pass/fail from the candidate's check — NOT the LLM's self-report.
  const objective = await objectiveCheck(candidate, sandbox, stepFailed);
  console.log('\n=== OBJECTIVE RESULT ===');
  console.log('passed:', objective.passed);
  const pf = candidate.pass_fail;
  console.log('check:', pf ? `${pf.type}:${pf.path ?? pf.command ?? ''}` : '(none)');
  console.log('expected:', pf?.expected ?? '(none)');
  console.log('check output:', objective.output.slice(0, 400));

  // Close the Serena session so the server exits and releases file locks.
  try {
    await serenaAdapter?.close();
  } catch {
    /* best-effort */
  }
  try {
    await leanAdapter?.close();
  } catch {
    /* best-effort */
  }

  // Clean up the sandbox after the run (Serena may hold locks — be resilient).
  try {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    console.log('\n(cleaned up test/artifacts)');
  } catch (err) {
    console.log('\n(cleanup warning:', (err as Error).message, ')');
  }
}

void main();
