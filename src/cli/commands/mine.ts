import { DEFAULT_SOURCE_DIR, inventorySource } from '../../mine/inventory';
import { MineStore } from '../../mine/store';
import { parseJsonlFile, rawToParsed, toRawConversation } from '../../mine/parse';
import { redactMessages } from '../../mine/redact';
import { extractFromConversation } from '../../mine/extract';
import { buildReviewSummary } from '../../mine/review';
import type { CliCommand } from '../types';

export interface MineDeps {
  /** Override the source directory (tests). Defaults to VS Code workspaceStorage. */
  sourceDir?: string;
  /** Override the mine db path (tests). */
  minePath?: string;
  /** Override the log sink (tests). */
  log?: (line: string) => void;
}

/** Resolve deps with defaults. */
function resolveDeps(deps: MineDeps): Required<Pick<MineDeps, 'sourceDir' | 'minePath' | 'log'>> {
  return {
    sourceDir: deps.sourceDir ?? DEFAULT_SOURCE_DIR,
    minePath: deps.minePath ?? process.env.CADET_BRAINSTEM_MINE ?? '',
    log: deps.log ?? ((line: string) => console.log(line)),
  };
}

function openStore(minePath: string): MineStore {
  return minePath.length > 0 ? new MineStore(minePath) : new MineStore();
}

function printInventory(deps: MineDeps): number {
  const { sourceDir, log } = resolveDeps(deps);
  const report = inventorySource(sourceDir);
  log(`Source: ${report.sourceDir}`);
  log(`Workspace folders with chatSessions: ${report.workspaceCount}`);
  log(`JSONL conversation files: ${report.jsonlCount}`);
  if (report.dateRange.earliest !== null) {
    log(`Date range: ${report.dateRange.earliest} .. ${report.dateRange.latest}`);
  } else {
    log('Date range: (no kind:0 creation dates found)');
  }
  log('');
  log('Conversation data is JSONL (one file per chat session):');
  log('  - kind:0  session metadata (sessionId, creationDate)');
  log('  - kind:1  property patches (ignored)');
  log('  - kind:2  message records (user request text + assistant response)');
  log('');
  log('Format confirmed. Awaiting review before extraction.');
  return 0;
}

function runParse(deps: MineDeps): number {
  const { sourceDir, minePath, log } = resolveDeps(deps);
  const report = inventorySource(sourceDir);
  const store = openStore(minePath);
  let saved = 0;
  for (const file of report.conversations) {
    const parsed = parseJsonlFile(file.path, file.workspace);
    // If no sessionId was found in kind:0, fall back to the file name.
    const withId =
      parsed.conversationId === 'unknown' || parsed.conversationId === undefined
        ? { ...parsed, conversationId: file.path.split(/[\\/]/).pop() ?? parsed.conversationId }
        : parsed;
    store.saveRaw(toRawConversation(withId));
    saved += 1;
  }
  log(`Parsed ${saved} conversations into procedure_candidates_raw (total ${store.countRaw()}).`);
  store.close();
  return 0;
}

function runScrub(deps: MineDeps): number {
  const { minePath, log } = resolveDeps(deps);
  const store = openStore(minePath);
  const raw = store.listRaw();
  let totalRedactions = 0;
  let updated = 0;
  for (const conversation of raw) {
    const { messages, redactions } = redactMessages(conversation.messages);
    if (store.updateRaw(conversation.id, messages, redactions)) {
      updated += 1;
    }
    totalRedactions += redactions;
  }
  log(`Scrubbed ${updated}/${raw.length} conversations; ${totalRedactions} total redactions.`);
  store.close();
  return 0;
}

async function runExtract(deps: MineDeps): Promise<number> {
  const { minePath, log } = resolveDeps(deps);
  const store = openStore(minePath);
  const raw = store.listRaw();
  let procedural = 0;
  let failures = 0;
  for (const conversation of raw) {
    const result = await extractFromConversation(rawToParsed(conversation));
    if (result.degraded) {
      failures += 1;
      log(`  [degraded] ${conversation.conversationId}`);
      continue;
    }
    if (!result.isProcedural) {
      continue;
    }
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
  log(
    `Extraction done: ${procedural} procedural candidates staged; ${failures} extraction failures.`,
  );
  store.close();
  return 0;
}

function runReview(deps: MineDeps): number {
  const { minePath, log } = resolveDeps(deps);
  const store = openStore(minePath);
  const summary = buildReviewSummary(store);
  log(`Conversations scanned: ${summary.totalScanned}`);
  log(`Procedural candidates staged: ${summary.proceduralCount}`);
  log('');
  log(`Sample (${summary.samples.length}):`);
  for (const c of summary.samples) {
    log(
      `  - [${c.confidence.toFixed(2)}] ${c.triggerPattern}  (${c.sourceWorkspace}, redactions=${c.redactions})`,
    );
    if (c.keywords.length > 0) log(`      keywords: ${c.keywords.join(', ')}`);
    if (c.steps.length > 0) log(`      steps: ${JSON.stringify(c.steps)}`);
  }
  log('');
  log('STOPPED FOR REVIEW — nothing promoted to the live procedures table.');
  store.close();
  return 0;
}

const SUBCOMMANDS = ['inventory', 'parse', 'scrub', 'extract', 'review'] as const;

export const mineCommand: CliCommand = {
  name: 'mine',
  description:
    'Mine historical conversations for procedure candidates (inventory|parse|scrub|extract|review)',
  usage:
    'cadet-brainstem mine <inventory|parse|scrub|extract|review> [--source <dir>] [--mine <db>]',
  run(args: readonly string[]): Promise<number> | number {
    const sub = args[0];
    const rest = args.slice(1);
    if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
      console.error(
        'Usage: cadet-brainstem mine <inventory|parse|scrub|extract|review> [--source <dir>] [--mine <db>]',
      );
      return 1;
    }
    const deps: MineDeps = {};
    for (let i = 0; i < rest.length; i += 1) {
      const next = rest[i + 1];
      if (rest[i] === '--source' && next !== undefined) {
        deps.sourceDir = next;
      } else if (rest[i] === '--mine' && next !== undefined) {
        deps.minePath = next;
      }
    }
    switch (sub) {
      case 'inventory':
        return printInventory(deps);
      case 'parse':
        return runParse(deps);
      case 'scrub':
        return runScrub(deps);
      case 'extract':
        return runExtract(deps);
      case 'review':
        return runReview(deps);
      default:
        return 1;
    }
  },
};
