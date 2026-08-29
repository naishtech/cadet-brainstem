/**
 * Test the mining pipeline (parse -> scrub -> extract) on a single JSONL chat
 * file and print the staged review result. Useful for sanity-checking one
 * conversation before running the full batch.
 *
 * Usage:
 *   npx tsx scripts/mine-single.ts <path-to.jsonl> [sourceWorkspace]
 */
import { parseJsonlFile, redactMessages, extractFromConversation, conversationToText } from '../src/mine';

async function main(): Promise<void> {
  const file = process.argv[2];
  const sourceWorkspace = process.argv[3] ?? 'ws';
  if (!file) {
    console.error('Usage: npx tsx scripts/mine-single.ts <path-to.jsonl> [sourceWorkspace]');
    process.exitCode = 1;
    return;
  }

  // Step 1.2 parse
  const parsed = parseJsonlFile(file, sourceWorkspace);
  console.log(`conversation_id: ${parsed.conversationId}`);
  console.log(`timestamp:       ${parsed.timestamp}`);
  console.log(`messages:        ${parsed.messages.length} (${parsed.messages.filter((m) => m.role === 'user').length} user, ${parsed.messages.filter((m) => m.role === 'assistant').length} assistant)`);

  // Step 1.3 scrub
  const { messages: scrubbed, redactions } = redactMessages(parsed.messages);
  console.log(`redactions:      ${redactions}`);

  // Step 1.4 extract (local LLM)
  const result = await extractFromConversation({ ...parsed, messages: scrubbed });
  console.log('');
  console.log('EXTRACTION:');
  console.log(`  is_procedural:   ${result.isProcedural}`);
  console.log(`  trigger_pattern: ${result.triggerPattern || '(none)'}`);
  console.log(`  keywords:        ${JSON.stringify(result.keywords)}`);
  console.log(`  steps:           ${JSON.stringify(result.steps)}`);
  console.log(`  confidence:      ${result.confidence}`);
  console.log(`  degraded:        ${result.degraded}`);
  console.log('');
  console.log('PROMPT TEXT SENT TO LLM (truncated):');
  console.log(conversationToText({ ...parsed, messages: scrubbed }).slice(0, 1200));
}

void main();
