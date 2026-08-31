/**
 * Read-only procedure set executed against a REAL repo (task-48 validation on
 * real code, not a sandbox). Uses the confirmed intent-grounded path: the local
 * LLM fills each tool's parameters from its syntax + intended args, then the
 * adapter executes it read-only against `cwd`.
 *
 * Usage:
 *   npx tsx scripts/repo-readonly-smoke.ts [repo-path]
 *
 * Prereqs: Ollama running with the model warmed; Serena + LeanCTX available.
 */
import { resolveBaseModel } from '../src/steering';
import { SerenaAdapter } from '../src/integrations/serena';
import { LeanCtxAdapter } from '../src/integrations/leanctx';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const REPO = process.argv[2] ?? process.cwd();

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

/** Reduce a path-like arg to a repo-relative path. */
function reducePath(value: string): string {
  return String(value).replace(/^[A-Za-z]:[\\/]/, '').replace(/^[\\/]+/, '').replace(/[\\]+/g, '/');
}

interface Spec {
  name: string;
  service: 'serena' | 'leanctx';
  tool: string;
  syntax: string;
  args: Record<string, unknown>;
}

const SPECS: Spec[] = [
  { name: 'find_symbol', service: 'serena', tool: 'find_symbol', syntax: '{ "name_path_pattern": "<symbol>" }', args: { name_path_pattern: 'findMatches' } },
  { name: 'find_referencing_symbols', service: 'serena', tool: 'find_referencing_symbols', syntax: '{ "name_path": "<symbol>", "relative_path": "<path>" }', args: { name_path: 'findMatches', relative_path: 'src/procedure/store.ts' } },
  { name: 'get_symbols_overview', service: 'serena', tool: 'get_symbols_overview', syntax: '{ "relative_path": "<path>" }', args: { relative_path: 'src/procedure/store.ts' } },
  { name: 'read_file', service: 'serena', tool: 'read_file', syntax: '{ "relative_path": "<path>" }', args: { relative_path: 'src/procedure/store.ts' } },
  { name: 'search_for_pattern', service: 'serena', tool: 'search_for_pattern', syntax: '{ "substring_pattern": "<regex>", "relative_path": "<path>" }', args: { substring_pattern: 'findMatches', relative_path: 'src/procedure' } },
  { name: 'ctx_tree', service: 'leanctx', tool: 'ctx_tree', syntax: '{ "path": "<dir>" }', args: { path: '.' } },
  { name: 'ctx_read', service: 'leanctx', tool: 'ctx_read', syntax: '{ "path": "<path>" }', args: { path: 'src/procedure/store.ts' } },
  { name: 'ctx_glob', service: 'leanctx', tool: 'ctx_glob', syntax: '{ "pattern": "<glob>", "path": "<dir>" }', args: { pattern: '**/*.ts', path: '.' } },
  { name: 'ctx_search', service: 'leanctx', tool: 'ctx_search', syntax: '{ "action": "regex", "pattern": "<regex>", "path": "<dir>" }', args: { action: 'regex', pattern: 'ProcedureStore', path: '.' } },
  { name: 'ctx_compose', service: 'leanctx', tool: 'ctx_compose', syntax: '{ "task": "<task>", "path": "<dir>" }', args: { task: 'summarize the procedure store module', path: '.' } },
];

async function runSerena(adapter: SerenaAdapter, spec: Spec): Promise<string> {
  const plan = (await llmJson(
    [
      `Task: ${spec.name}.`,
      `You must call the Serena tool "${spec.tool}" on the project.`,
      `Serena ${spec.tool} syntax: ${spec.syntax}`,
      `The intended parameter values are: ${JSON.stringify(spec.args)}. Fill the tool's parameters using exactly these values.`,
      `Return ONLY the fields named in the syntax. Respond with JSON: {"arguments": {<parameters>}}.`,
    ].join('\n'),
    { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'] },
  )) as { arguments?: Record<string, unknown> };
  if (!plan.arguments) return '(no arguments proposed)';
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(plan.arguments)) {
    if (v === undefined || v === null) continue;
    if (k === 'file' || k === 'path' || k === 'relative_path' || k === 'file_name') normalized[k] = reducePath(String(v));
    else normalized[k] = v;
  }
  const r = await adapter.callTool({ tool: spec.tool, arguments: normalized, cwd: REPO });
  return `${r.rawText}`;
}

async function runLean(adapter: LeanCtxAdapter, spec: Spec): Promise<string> {
  const plan = (await llmJson(
    [
      `Task: ${spec.name}.`,
      `You must call the LeanCTX tool "${spec.tool}" on the project.`,
      `LeanCTX ${spec.tool} syntax: ${spec.syntax}`,
      `The intended parameter values are: ${JSON.stringify(spec.args)}. Fill the tool's parameters using exactly these values.`,
      `Return ONLY the fields named in the syntax. Respond with JSON: {"arguments": {<parameters>}}.`,
    ].join('\n'),
    { type: 'object', properties: { arguments: { type: 'object' } }, required: ['arguments'] },
  )) as { arguments?: Record<string, unknown> };
  if (!plan.arguments) return '(no arguments proposed)';
  const r = await adapter.callTool({ tool: spec.tool, arguments: plan.arguments, cwd: REPO });
  return `${r.rawText}`;
}

async function main(): Promise<void> {
  console.log(`Repo: ${REPO}`);
  const serena = new SerenaAdapter();
  try {
    await serena.callTool({ tool: 'activate_project', arguments: { project: REPO }, cwd: REPO });
  } catch (e) {
    console.log('activate_project warn:', (e as Error).message);
  }
  const lean = new LeanCtxAdapter();

  let pass = 0;
  let fail = 0;
  for (const spec of SPECS) {
    process.stdout.write(`\n-- ${spec.service}:${spec.name} --\n`);
    try {
      const out = spec.service === 'serena' ? await runSerena(serena, spec) : await runLean(lean, spec);
      const ok = !/Error executing tool|DEGRADED: true/.test(out);
      if (ok) {
        pass += 1;
      } else {
        fail += 1;
      }
      console.log(`result: ${ok ? 'PASS' : 'FAIL'}`);
      console.log(`output: ${out.slice(0, 400)}`);
    } catch (err) {
      fail += 1;
      console.log(`result: FAIL (${(err as Error).message})`);
    }
  }
  console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
  try { await serena.close(); } catch { /* best-effort */ }
  try { await lean.close(); } catch { /* best-effort */ }
}

void main();
