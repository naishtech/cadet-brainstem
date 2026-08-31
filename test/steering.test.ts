import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENTS = readFileSync(
  fileURLToPath(new URL('../AGENTS.md', import.meta.url)),
  'utf8',
);

/**
 * Deterministic steering-contract test: asserts the required directives are
 * present and correctly worded in the agent instructions. This guards the
 * instruction text (so it cannot be weakened or deleted silently); it does
 * NOT — and cannot — prove an LLM obeys it. Guaranteed runtime enforcement
 * requires a gateway/wrapper that calls steer before the model (design
 * doc §16), which is separately integration-tested.
 */
const REQUIRED_PHRASES = [
  'Steer every user request',
  'call the `steering` MCP tool',
  'not the verbatim message',
  'response_policy',
  'tool_plan',
  'memory_policy',
  'chat_memory_store',
] as const;

describe('steering contract (AGENTS.md)', () => {
  it.each(REQUIRED_PHRASES)('requires "%s"', (phrase) => {
    expect(AGENTS).toContain(phrase);
  });
});
