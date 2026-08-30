/**
 * Peek at a subset of conversations (user turns) so the agent can curate
 * procedure candidates manually. Reads user message text only — assistant
 * replies are encrypted in this export format.
 *
 * Usage:
 *   npx tsx scripts/curate-peek.ts [--limit N] [--source <dir>]
 */
import { inventorySource, parseJsonlFile } from '../src/mine';

function parseArgs(argv: string[]): { limit: number; source?: string } {
  const out: { limit: number; source?: string } = { limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === '--limit' && next !== undefined) out.limit = Number(next);
    if (argv[i] === '--source' && next !== undefined) out.source = next;
  }
  return out;
}

function main(): void {
  const { limit, source } = parseArgs(process.argv.slice(2));
  const report = inventorySource(source);
  const files = report.conversations.slice(0, limit);
  console.log(`showing ${files.length} of ${report.jsonlCount} conversations\n`);
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const parsed = parseJsonlFile(file.path, file.workspace);
    console.log(`--- #${i + 1} [${file.workspace}] ${parsed.conversationId} (${parsed.messages.filter((m) => m.role === 'user').length} user turns) ---`);
    for (const msg of parsed.messages.filter((m) => m.role === 'user').slice(0, 4)) {
      const line = msg.text.replace(/\s+/g, ' ').slice(0, 220);
      console.log(`  U: ${line}`);
    }
    console.log('');
  }
}

main();
