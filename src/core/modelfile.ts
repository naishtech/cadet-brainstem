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

const EXAMPLES = `Request: "why is the checkout page throwing a 500 sometimes"
{"task":"debug","complexity":"medium","risk":"high","context_need":"targeted","entities":["checkout page","500","payment","error handling"],"confidence":0.85,"needs_more_context":true}

Request: "make a plan to document the project's blueprints and code under Docs/Components, producing markdown per component"
{"task":"documentation","complexity":"high","risk":"low","context_need":"broad","entities":["blueprints","code","Docs/Components","component","markdown"],"confidence":0.75,"needs_more_context":false}`;

const SYSTEM = `You are a fast, lightweight routing classifier. Read the user's coding request and output ONLY a minimal classification as valid JSON matching the exact shape below. Do NOT solve the request, do NOT explain reasoning, do NOT invent repository facts, and do NOT suggest tools or search queries — tool and retrieval selection is handled separately. The output JSON schema is enforced by the caller; emit exactly the fields below.

JSON SHAPE (emit exactly these fields):
{
  "task": "...",
  "complexity": "low | medium | high",
  "risk": "low | medium | high",
  "context_need": "minimal | targeted | broad | exhaustive",
  "entities": ["<noun or keyword pulled directly from the request>"],
  "confidence": 0.0,
  "needs_more_context": false
}

FIELD DEFINITIONS — use exactly these.
task (ONE): question=how something works, no code change; coding_new=new feature; coding_fix=known bug, known cause; debug=bug cause NOT yet known; refactor=restructure, behavior unchanged; test=write/fix tests; review=review existing code/diff/PR (NOT planning); architecture=design/compare approaches; documentation=write docs/comments; investigation=explore codebase, no clear task; planning=break into steps/roadmap; search=find where something is defined/used; configuration=edit config/env/build.
Rule: "design/plan/figure out how to approach/explore options" -> architecture, planning, or investigation. NEVER review.
complexity (ONE): low=single file, obvious; medium=multiple files OR design decisions; high=cross-cutting, unclear requirements, many files.
risk (ONE): low=reversible, no prod/data/security impact; medium=shared code/tests/user-facing; high=auth, payments, data migrations, prod config, or deletes data.
context_need (ONE): minimal=no repo access; targeted=1-3 files/one area; broad=several related areas; exhaustive=full repo survey.

entities: a list of the key NOUNS and keywords literally present (or clearly implied) in the request — e.g. "checkout page", "blueprint", "X300", "Docs/Components". This is simple EXTRACTION, NOT reasoning: do not invent tools, do not reason about how to accomplish the task, do not suggest commands. 2-6 entries is typical; order by importance.

confidence: 0.0-1.0, how sure you are of this classification.
needs_more_context: true ONLY if the request itself is insufficient to classify without repo access.

EXAMPLES (classification + entity extraction only):
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
