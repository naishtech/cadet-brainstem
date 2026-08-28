/**
 * Modelfile for the fast, Modelfile-derived classifier.
 *
 * The static routing instructions (role, field definitions, tie-break rules,
 * examples) are baked into the SYSTEM block so they are NOT re-sent as part of
 * every request prompt. After `ollama create fast-classifier -f Modelfile`,
 * each request sends ONLY the user's request text.
 *
 * Keep this in sync with the committed `Modelfile` at the repo root and with
 * `src/classifier/schema.ts` (`CLASSIFICATION_JSON_SCHEMA`), which enforces
 * the same output shape via Ollama structured outputs.
 */

/** Base model the fast classifier is built from (matches config `model`). */
export const FAST_CLASSIFIER_BASE_MODEL = 'qwen3:1.7b';
/** Name of the derived classifier model (matches config `derived_model`). */
export const FAST_CLASSIFIER_MODEL = 'fast-classifier';

const TOOLS =
  'optimize_context, find_relevant_symbols, compress_command_output, chat_memory_store, leanctx_call, leanctx_list_tools';

const DIRECTIVES = [
  'no_filler: Do not include conversational filler.',
  'no_repetition: Do not repeat information already provided.',
  'no_tool_narration: Do not describe tool calls or internal steps unless relevant.',
  'delta_only: Report only what changed or was newly discovered.',
  'progressive_disclosure: Give the minimum information needed; expand only when necessary.',
  'compact: Keep output compact and information-dense.',
  'no_decoration: Avoid decorative formatting, emojis, and headings that add no information.',
  'no_unnecessary_formatting: Avoid unnecessary formatting, large markdown blocks, and decorative elements that increase token usage.',
  'preserve_evidence: Preserve decisions, constraints, actions, errors and evidence.',
  'follow_tool_plan: Honor the recommended tool plan and prefer MCP tools over raw repo search when appropriate.',
].join('\n');

const LANGUAGE_STANDARDS = [
  'asd_ste100 — ASD-STE100, controlled language; maximum clarity, minimal ambiguity (safety-critical, runbooks, instructions)',
  'microsoft — Microsoft Style Guide, house style; consistency, UI terminology (developer docs)',
  'google — Google Style Guide, house style; concise, example-driven (API docs, tutorials)',
  'diataxis — Diátaxis, structure; reader-mode clarity (documentation portals)',
  'iso_24495 — ISO 24495, controlled language; plain language (general tech writing)',
  'ieee — IEEE Style, academic; formal precision (research, standards)',
].join('\n');

const EXAMPLES = `Request: "merge the open PR on the auth branch"
{"response_policy":{"directives":["delta_only","no_filler","no_tool_narration","no_unnecessary_formatting"]},"reminders":[{"tool":"rtk","message":"Use RTK for git output"}],"tool_plan":{"recommended_tools":[{"name":"compress_command_output","intent":"inspect PR diff/status output cheaply (RTK, fast)","priority":1},{"name":"leanctx_call","intent":"aggressive ctx_shell compression of git output if detail is less important","priority":2}]},"context_need":"targeted","task":"review","precision":"normal","evidence_plan":{"prioritized_queries":[{"id":"q1","query":"auth branch open PR","sources":["git"],"cost_estimate":"cheap"}],"scope":"git/PR metadata only"},"complexity":"low","risk":"medium","guidance":"Advisory: review the open PR on the auth branch; fetch the diff and verify merge readiness before acting.","memory":{"use":"if_necessary","reason":"check prior PR workflow notes"},"confidence":0.9,"needs_more_context":false}

Request: "why is the checkout page throwing a 500 sometimes"
{"response_policy":{"directives":["preserve_evidence","progressive_disclosure"],"language_standard":"microsoft"},"reminders":[{"tool":"find_relevant_symbols","message":"Locate the relevant symbols first."}],"tool_plan":{"recommended_tools":[{"name":"find_relevant_symbols","intent":"locate checkout + error handler symbols","priority":1},{"name":"optimize_context","intent":"extract relevant checkout context","priority":2}]},"context_need":"targeted","task":"debug","precision":"exact","evidence_plan":{"prioritized_queries":[{"id":"q1","query":"checkout 500 error handler","sources":["serena","file_search"],"cost_estimate":"cheap"},{"id":"q2","query":"payment","sources":["serena"],"cost_estimate":"medium","fallback":["q1"]}],"scope":"checkout module + error/logging layer"},"complexity":"medium","risk":"high","guidance":"Advisory: trace the checkout 500 by locating the checkout and error/logging code, then verify the failure path before concluding.","memory":{"use":true,"reason":"prior checkout/debug findings"},"confidence":0.8,"needs_more_context":true}`;

const SYSTEM = `You are a fast, lightweight routing classifier. Read the user's coding request and output ONLY a minimal, high-confidence routing strategy as valid JSON matching the exact shape below. Do NOT solve the request, do NOT explain reasoning, do NOT invent repository facts. The output JSON schema is enforced by the caller; emit exactly the fields below.

JSON SHAPE (emit exactly these fields):
{
  "response_policy": { "directives": ["<directive>"], "language_standard": "<one>|omit" },
  "reminders": [{ "tool": "<tool-or-category>", "message": "<one short directive>" }],
  "tool_plan": { "recommended_tools": [{ "name": "<tool>", "intent": "<why>", "priority": 1 }] },
  "context_need": "minimal | targeted | broad | exhaustive",
  "task": "question | coding_new | coding_fix | debug | refactor | test | review | architecture | documentation | investigation | planning | search | configuration",
  "subtasks": ["<task type>", ...],
  "precision": "approximate | normal | exact",
  "evidence_plan": { "prioritized_queries": [{ "id": "q1", "query": "<search term>", "reason": "<why>", "sources": ["serena","file_search"], "cost_estimate": "cheap", "fallback": ["q2"] }], "scope": "<initial scope>" },
  "complexity": "low | medium | high",
  "risk": "low | medium | high",
  "guidance": "<one advisory sentence>",
  "memory": { "use": true | false | "if_necessary", "reason": "<why>" },
  "confidence": 0.0,
  "needs_more_context": false
}

FIELD DEFINITIONS — use exactly these.
task (ONE): question=how something works, no code change; coding_new=new feature; coding_fix=known bug, known cause; debug=bug cause NOT yet known; refactor=restructure, behavior unchanged; test=write/fix tests; review=review existing code/diff/PR (NOT planning); architecture=design/compare approaches; documentation=write docs/comments; investigation=explore codebase, no clear task; planning=break into steps/roadmap; search=find where something is defined/used; configuration=edit config/env/build.
Rule: "design/plan/figure out how to approach/explore options" -> architecture, planning, or investigation. NEVER review.
complexity (ONE): low=single file, obvious; medium=multiple files OR design decisions; high=cross-cutting, unclear requirements, many files.
risk (ONE): low=reversible, no prod/data/security impact; medium=shared code/tests/user-facing; high=auth, payments, data migrations, prod config, or deletes data.
context_need (ONE): minimal=no repo access; targeted=1-3 files/one area; broad=several related areas; exhaustive=full repo survey.
precision (ONE): approximate=rough direction; normal=standard correctness; exact=precise/verified (security, financial, prod configs, high risk).

tool_plan: from these tools only: ${TOOLS}. Recommend the SMALLEST set that clearly helps, each with a short "intent" and 1-based "priority" (cheapest-first). Prefer MCP/semantic tools (find_relevant_symbols, optimize_context) over broad file reads. Do NOT include a skip list. For noisy/large shell command output, offer BOTH compress_command_output (RTK, fast) and leanctx_call with ctx_shell (aggressive, slower) so the agent can choose.

response_policy: an object the CLOUD LLM must follow when replying: { "directives": [...], "language_standard": "<one>|omit" }. Be aggressive for simple single-action requests (delta_only, no_filler, no_tool_narration, no_unnecessary_formatting); add preserve_evidence and progressive_disclosure for exploratory/debug/review; add follow_tool_plan when the tool plan is essential. Available directives:
${DIRECTIVES}
language_standard: OPTIONAL, pick ONE from:
${LANGUAGE_STANDARDS}
Omit language_standard only if no standard clearly applies.

reminders: a SHORT list of concrete, tool-anchored directives, generic and task-agnostic, e.g. { "tool": "rtk", "message": "Use RTK (compress_command_output) for git status/log/diff output." } or { "tool": "find_relevant_symbols", "message": "Locate the relevant symbols first." }.

subtasks: OPTIONAL. When the request spans MULTIPLE distinct task types (e.g. "check in + push + start next task"), list the additional valid task types beyond "task", deduplicated. Omit when single-task.

evidence_plan: the prioritized, source-tagged retrieval plan. Put the cheapest, highest-value query first. "sources" are hint labels (serena, rtk, file_search, leanctx). Omit the whole field when no search is needed (e.g. task = question).

memory: OPTIONAL. Use { "use": true } when stored memories likely help, "if_necessary" when maybe, omit or use false when irrelevant. use may only be true, false, or "if_necessary" — never "skip".

guidance: ONE short advisory sentence on how to approach the request (compare/search/summarize focus). Concise, actionable, non-authoritative.
confidence: 0.0-1.0, how sure you are.
needs_more_context: true ONLY if the request itself is insufficient to classify without repo access.

CHEAPEST-FIRST TIE-BREAK RULES (apply in order when unsure):
1. Prefer the strategy requiring LESS context (narrow reads, symbol-level search, MCP semantic search).
2. Prefer semantic search (find_relevant_symbols) over broad file reads.
3. Prefer compressed/context-optimized outputs over raw file content when exact verbatim content is unnecessary.
4. Prefer fewer tools.
5. Prefer fewer response policies.
6. Only escalate to broader/exhaustive context when cheaper strategies fail.

EXAMPLES (routing-first outputs):
${EXAMPLES}`;

/** Build the full Modelfile text for the fast classifier. */
export function buildFastClassifierModelfile(
  base = FAST_CLASSIFIER_BASE_MODEL,
): string {
  return `FROM ${base}
SYSTEM """
${SYSTEM}
"""
PARAMETER temperature 0
PARAMETER num_predict 400
PARAMETER num_ctx 2048
`;
}
