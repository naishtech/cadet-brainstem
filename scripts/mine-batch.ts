/**
 * Run the full mining batch (parse -> scrub -> extract -> review) across all
 * JSONL conversations and stage procedural candidates for human review.
 *
 * Writes to the mining DB (default ~/.cadet-brainstem/mine.db, override
 * CADET_BRAINSTEM_MINE). NEVER touches the live `procedures` table.
 *
 * Usage:
 *   npx tsx scripts/mine-batch.ts [--limit <n>] [--source <dir>]
 */
import {
  MineStore,
  inventorySource,
  parseJsonlFile,
  redactMessages,
  extractFromConversation,
  rawToParsed,
  toRawConversation,
  buildReviewSummary,
} from '../src/mine';

function parseArgs(argv: string[]): { limit?: number; source?: string } {
  const out: { limit?: number; source?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--limit' && next !== undefined) out.limit = Number(next);
    if (argv[i] === '--source' && next !== undefined) out.source = next;
  }
  return out;
}

async function main(): Promise<void> {
  const { limit, source } = parseArgs(process.argv.slice(2));
  const store = new MineStore();
  const report = inventorySource(source);

  const files = limit !== undefined ? report.conversations.slice(0, limit) : report.conversations;
  console.log(`Total conversations: ${report.jsonlCount}; processing ${files.length}`);

  // Step 1.2 parse
  let saved = 0;
  for (const file of files) {
    const parsed = parseJsonlFile(file.path, file.workspace);
    const id =
      parsed.conversationId === 'unknown' ? (file.path.split(/[\\/]/).pop() ?? parsed.conversationId) : parsed.conversationId;
    store.saveRaw(toRawConversation({ ...parsed, conversationId: id }));
    saved += 1;
  }
  console.log(`Parsed ${saved} -> raw table (${store.countRaw()})`);

  // Step 1.3 scrub
  let totalRedactions = 0;
  for (const conversation of store.listRaw()) {
    const { messages, redactions } = redactMessages(conversation.messages);
    store.updateRaw(conversation.id, messages, redactions);
    totalRedactions += redactions;
  }
  console.log(`Scrubbed; ${totalRedactions} total redactions`);

  // Step 1.4 extract (local LLM)
  let procedural = 0;
  let failures = 0;
  for (const conversation of store.listRaw()) {
    const result = await extractFromConversation(rawToParsed(conversation));
    if (result.degraded) {
      failures += 1;
      console.log(`  [degraded] ${conversation.conversationId}`);
      continue;
    }
    if (!result.isProcedural) continue;
    store.saveReview({
      sourceWorkspace: conversation.sourceWorkspace,
      sourceConversationId: result.sourceConversationId,
      timestamp: result.timestamp,
      triggerPattern: result.triggerPattern,
      keywords: result.keywords,
      steps: result.steps,
      isProcedural: true,
      confidence: result.confidence,
      redactions: conversation.redactions,
    });
    procedural += 1;
  }
  console.log(`Extraction: ${procedural} procedural staged; ${failures} failures`);

  // Step 1.5 review
  const summary = buildReviewSummary(store);
  console.log(`\nREVIEW: scanned=${summary.totalScanned} staged=${summary.proceduralCount}`);
  for (const c of summary.samples) {
    console.log(`  - [${c.confidence.toFixed(2)}] ${c.triggerPattern} (${c.sourceWorkspace}, redactions=${c.redactions})`);
  }
  store.close();
}

void main();
