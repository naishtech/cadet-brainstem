/**
 * Classifier reasoning-capacity probe.
 *
 * Purpose: find the point at which the raw (small) Ollama model stops being
 * able to produce a schema-valid classification. We test the model DIRECTLY
 * (not through the cadet classify pipeline) so we can isolate its ceiling.
 *
 * Two axes ramp up together:
 *   - REASONING: the requests get progressively harder (trivial question →
 *     ambiguous, cross-cutting, repo-wide planning).
 *   - SCHEMA: the JSON output schema grows, field by field. We start with the
 *     lean core (no `guidance`) and add fields per level so we can see exactly
 *     which field(s) push the model over the edge (invalid JSON, dropped
 *     fields, or timeouts).
 *
 * Usage (from repo root):
 *   npx tsx scripts/classifier-reasoning-probe.ts                 # full battery
 *   npx tsx scripts/classifier-reasoning-probe.ts --model qwen3:1.7b
 *   PROBE_REQUESTS=1,3,5 PROBE_LEVELS=0,2,4 npx tsx scripts/classifier-reasoning-probe.ts
 *
 * Output: a per-(request × schema-level) table to stdout, plus a full JSON
 * dump (raw outputs included) written to scripts/output/ for later inspection.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLASSIFICATION_JSON_SCHEMA } from '../src/classifier/schema';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const MODEL = parseArg('--model', process.env.PROBE_MODEL ?? 'qwen3:1.7b');
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);
const NUM_PREDICT = Number(process.env.PROBE_NUM_PREDICT ?? 800);
// When set (--schema-file <path>), probe all selected requests with this single
// JSON schema instead of the built-in progressive level ramp.
const SCHEMA_FILE = parseArg('--schema-file', process.env.PROBE_SCHEMA_FILE ?? '');

/** Progressive reasoning levels — request text grows in complexity/ambiguity. */
const REQUESTS: Array<{ id: number; reasoning: string; text: string }> = [
  {
    id: 1,
    reasoning: 'trivial — pure question, one file',
    text: 'What does the debounce function do in utils.js?',
  },
  {
    id: 2,
    reasoning: 'simple — known one-line fix',
    text: 'Fix the typo in the login error message.',
  },
  {
    id: 3,
    reasoning: 'moderate — debug, cause unknown',
    text: 'Why does the checkout page intermittently return 500 errors? Find the likely cause.',
  },
  {
    id: 4,
    reasoning: 'hard — multi-file refactor + tests',
    text: 'Refactor the inventory system to use composition over inheritance and update its tests.',
  },
  {
    id: 5,
    reasoning: 'hardest — repo-wide, ambiguous, exhaustive',
    text: "Plan a full documentation effort for the project's blueprints and code, requiring MCP inspection of the blueprints, producing per-component markdown under a new Docs folder, and saving the plan to a file.",
  },
];

/**
 * Progressive schema levels — each adds fields to the previous. Level 0 is the
 * lean core (no `guidance`), matching the idea of asking the model to skip
 * rich fields first, then ramping them in.
 */
const SCHEMA_LEVELS: Array<{ level: number; fields: string[] }> = [
  { level: 0, fields: ['task', 'complexity', 'risk', 'context_need', 'precision'] },
  { level: 1, fields: ['confidence', 'needs_more_context'] },
  { level: 2, fields: ['response_policy', 'memory'] },
  { level: 3, fields: ['tool_plan', 'reminders'] },
  { level: 4, fields: ['evidence_plan', 'guidance', 'subtasks'] },
];

function parseArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : fallback;
}

function parseSelection(envName: string, total: number): number[] {
  const raw = process.env[envName];
  if (!raw) {
    return Array.from({ length: total }, (_, i) => i);
  }
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < total);
}

/**
 * Parse PROBE_REQUESTS as 1-based request IDs (matching each request's `id`),
 * e.g. PROBE_REQUESTS=1,3 selects R1 and R3. Returns the matching request
 * objects. Defaults to all requests, in order (simplest first).
 */
function selectRequests(): typeof REQUESTS {
  const raw = process.env.PROBE_REQUESTS;
  if (!raw) {
    return REQUESTS;
  }
  const ids = new Set(
    raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= REQUESTS.length),
  );
  return REQUESTS.filter((r) => ids.has(r.id));
}

/** All fields selected up to and including a given level, in schema order. */
function fieldsFor(level: number): string[] {
  return SCHEMA_LEVELS.slice(0, level + 1).flatMap((l) => l.fields);
}

/** Build a JSON schema subset from the full classification schema. */
function buildSchema(level: number): Record<string, unknown> {
  const fields = fieldsFor(level);
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const prop = (CLASSIFICATION_JSON_SCHEMA as any).properties?.[field];
    if (prop !== undefined) {
      properties[field] = prop;
    }
  }
  return {
    type: 'object',
    properties,
    required: fields.filter((f) => properties[f] !== undefined),
    additionalProperties: false,
  };
}

interface ProbeResult {
  latencyMs: number;
  valid: boolean;
  fieldsPresent: number;
  fieldsRequired: number;
  error?: string;
  parsed?: Record<string, unknown>;
  raw: string;
}

async function probe(requestText: string, schema: Record<string, unknown>): Promise<ProbeResult> {
  const start = Date.now();
  const required = (schema.required as string[]) ?? [];
  try {
    const response = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: `You are a routing classifier. Classify the request below and return ONLY the JSON routing strategy, matching the schema exactly (same field names).\n\nRequest: ${requestText}`,
          },
        ],
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0, num_predict: NUM_PREDICT, num_ctx: 2048 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await response.json()) as { message?: { content?: string } };
    const content = data.message?.content ?? '';
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return {
        latencyMs: Date.now() - start,
        valid: false,
        fieldsPresent: 0,
        fieldsRequired: required.length,
        error: `non-JSON output (${content.slice(0, 120)})`,
        raw: content,
      };
    }
    const present = required.filter((f) => parsed?.[f] !== undefined).length;
    return {
      latencyMs: Date.now() - start,
      valid: true,
      fieldsPresent: present,
      fieldsRequired: required.length,
      parsed,
      raw: content,
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - start,
      valid: false,
      fieldsPresent: 0,
      fieldsRequired: required.length,
      error: `TIMEOUT/ERR: ${(err as Error).message.slice(0, 100)}`,
      raw: '',
    };
  }
}

async function main(): Promise<void> {
  const reqSel = selectRequests();
  const lvlSel = parseSelection('PROBE_LEVELS', SCHEMA_LEVELS.length);

  console.log(`Model: ${MODEL}  Host: ${HOST}`);
  console.log(
    `Battery: ${reqSel.length} request(s) × ${lvlSel.length} schema-level(s)  ` +
      `(requests ${reqSel.map((r) => r.id).join(',')}, levels ${lvlSel.join(',')})\n`,
  );

  const results: Array<{
    requestId: number;
    level: number;
    fields: string[];
    result: ProbeResult;
  }> = [];

  if (SCHEMA_FILE) {
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as Record<string, unknown>;
    const required = (schema.required as string[]) ?? [];
    console.log(`Custom schema from: ${SCHEMA_FILE}`);
    console.log(`Required fields [${required.join(',')}]\n`);
    for (const req of reqSel) {
      console.log(`### R${req.id} — ${req.reasoning}`);
      console.log(`    "${req.text}"`);
      const res = await probe(req.text, schema);
      results.push({ requestId: req.id, level: -1, fields: required, result: res });
      const status = res.valid
        ? `VALID ${res.fieldsPresent}/${res.fieldsRequired} fields`
        : res.error ?? 'INVALID';
      console.log(`  ${String(res.latencyMs).padStart(6)}ms  ${status}`);
      if (res.valid && res.parsed) {
        console.log(`  tool_plan: ${JSON.stringify((res.parsed as any).tool_plan ?? null)}`);
        console.log(`  evidence_plan: ${JSON.stringify((res.parsed as any).evidence_plan ?? null)}`);
      }
    }
  } else {
    for (const req of reqSel) {
      console.log(`\n### R${req.id} — ${req.reasoning}`);
      console.log(`    "${req.text}"`);
      for (const li of lvlSel) {
        const level = SCHEMA_LEVELS[li];
        if (level === undefined) {
          continue;
        }
        const fields = fieldsFor(level.level);
        const schema = buildSchema(level.level);
        const res = await probe(req.text, schema);
        results.push({ requestId: req.id, level: level.level, fields, result: res });

        const status = res.valid
          ? `VALID ${res.fieldsPresent}/${res.fieldsRequired} fields`
          : res.error ?? 'INVALID';
        console.log(
          `  L${level.level} [${fields.join(',')}]  ${String(res.latencyMs).padStart(6)}ms  ${status}`,
        );
      }
    }
  }

  try {
    mkdirSync(join(__dirname, 'output'), { recursive: true });
    const outPath = join(
      __dirname,
      'output',
      `reasoning-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(outPath, JSON.stringify({ model: MODEL, results }, null, 2), 'utf8');
    console.log(`\nFull results written to ${outPath}`);
  } catch {
    // best-effort
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
