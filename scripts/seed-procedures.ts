/**
 * Seed the `procedures` table with initial procedures (task 44).
 *
 * The local LLM executes these on behalf of the cloud LLM. Every step maps to a
 * real local service the local LLM has: LeanCTX (`leanctx`), Serena
 * (`serena`), RTK (`rtk`). Read-only steps default to `auto_execute`; Serena
 * edit steps (`replace_lines` / `delete_lines` / `insert_lines`) are write
 * actions and default to `requires_review`.
 *
 * Usage:
 *   npm run seed:procedures            # seed only if the table is empty
 *   npm run seed:procedures -- --force # clear and re-seed
 */
import { ProcedureStore, getDefaultProcedurePath, type SeedProcedureInput } from '../src/procedure/index';

const SEED: SeedProcedureInput[] = [
  {
    triggerPattern: 'Gather and compress relevant context',
    keywords: ['context', 'read', 'compress', 'file', 'ctx'],
    steps: [{ service: 'leanctx', tool: 'ctx_read', args: { mode: 'map' } }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To read/compress a file for context, ask the local LLM to call ctx_read with the project-relative path, e.g. { path: "src/main.cpp" }.',
  },
  {
    triggerPattern: 'Find symbols for a change',
    keywords: ['symbol', 'find', 'reference', 'rename', 'serena'],
    steps: [{ service: 'serena', tool: 'find_symbol', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To find a symbol, ask the local LLM to call find_symbol with { name_path_pattern: "<symbol>" }.',
  },
  {
    triggerPattern: 'Get a file symbols overview',
    keywords: ['overview', 'symbols', 'file', 'structure', 'serena'],
    steps: [{ service: 'serena', tool: 'get_symbols_overview', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To list a file symbols, ask the local LLM to call get_symbols_overview with { relative_path: "<path>" }.',
  },
  {
    triggerPattern: 'Read a file',
    keywords: ['read', 'file', 'content', 'serena'],
    steps: [{ service: 'serena', tool: 'read_file', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To read a file, ask the local LLM to call read_file with { relative_path: "<path>" }.',
  },
  {
    triggerPattern: 'Run diagnostics on a file',
    keywords: ['diagnostic', 'diagnostics', 'lint', 'issues', 'errors', 'check', 'compile', 'serena'],
    steps: [{ service: 'serena', tool: 'get_diagnostics_for_file', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To run diagnostics on a file, ask the local LLM to call get_diagnostics_for_file with { relative_path: "<path>" }, then report the issues it returns (or that there are none). Do NOT fabricate a language-server result — the local LLM must actually invoke the tool.',
  },
  {
    triggerPattern: 'Search a file for a pattern',
    keywords: ['search', 'pattern', 'regex', 'find', 'serena'],
    steps: [{ service: 'serena', tool: 'search_for_pattern', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To search for a pattern, ask the local LLM to call search_for_pattern with { substring_pattern: "<regex>", relative_path: "<path>" }.',
  },
  {
    triggerPattern: 'Summarize project structure',
    keywords: ['structure', 'explore', 'tree', 'layout', 'project'],
    steps: [{ service: 'leanctx', tool: 'ctx_tree', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To list the project tree, ask the local LLM to call ctx_tree with { path: "." }.',
  },
  {
    triggerPattern: 'Compress a command output',
    keywords: ['compress', 'command', 'output', 'rtk', 'shell'],
    steps: [{ service: 'rtk', tool: 'compress_command_output', args: {} }],
    riskTier: 'auto_execute', // read-only, local
    handoffShape:
      'To compress a command output, ask the local LLM to run rtk on a concrete, safe read-only command (git status, ls). NOTE: the local model is weak at choosing the command — provide the exact command.',
  },
  {
    triggerPattern: 'Create a file',
    keywords: ['create', 'file', 'write', 'new', 'serena'],
    steps: [{ service: 'serena', tool: 'create_text_file', args: {} }],
    riskTier: 'requires_review', // write action
    handoffShape:
      'To create a file, ask the local LLM to call create_text_file with { relative_path: "<bare filename>", content: "<text>" }. Keep relative_path a bare filename (no directories).',
  },
  {
    triggerPattern: 'Replace content in a file',
    keywords: ['replace', 'content', 'edit', 'change', 'serena'],
    steps: [{ service: 'serena', tool: 'replace_content', args: {} }],
    riskTier: 'requires_review', // write action
    handoffShape:
      'To replace text in a file, ask the local LLM to call replace_content with { relative_path: "<path>", needle: "<old text>", repl: "<new text>", mode: "literal" }.',
  },
  {
    triggerPattern: 'Insert a function after a symbol',
    keywords: ['insert', 'function', 'symbol', 'add', 'serena'],
    steps: [{ service: 'serena', tool: 'insert_after_symbol', args: {} }],
    riskTier: 'requires_review', // write action
    handoffShape:
      'To insert code after a symbol, ask the local LLM to call insert_after_symbol with { name_path: "<symbol>", relative_path: "<path>", body: "<text>" }.',
  },
  {
    triggerPattern: 'Create, read, then edit a file',
    keywords: ['create', 'read', 'edit', 'sequence', 'multi-step', 'serena'],
    steps: [
      { service: 'serena', tool: 'create_text_file', args: {} },
      { service: 'serena', tool: 'read_file', args: {} },
      { service: 'serena', tool: 'replace_content', args: {} },
    ],
    riskTier: 'requires_review', // includes a write step
    handoffShape:
      'Ask the local LLM to run this exact ordered sequence on one file: 1) create_text_file {relative_path, content}, 2) read_file {relative_path}, 3) replace_content {relative_path, needle, repl, mode:"literal"}. Give it the file name and contents.',
  },
  {
    triggerPattern: 'Find, overview, then edit a file',
    keywords: ['find', 'overview', 'edit', 'sequence', 'multi-step', 'serena'],
    steps: [
      { service: 'serena', tool: 'find_symbol', args: {} },
      { service: 'serena', tool: 'get_symbols_overview', args: {} },
      { service: 'serena', tool: 'replace_content', args: {} },
    ],
    riskTier: 'requires_review', // includes a write step
    handoffShape:
      'Ask the local LLM to run this exact ordered sequence: 1) find_symbol {name_path_pattern}, 2) get_symbols_overview {relative_path}, 3) replace_content {relative_path, needle, repl, mode:"literal"}. Provide the symbol and file path.',
  },
  {
    triggerPattern: 'Gather context then edit a file',
    keywords: ['context', 'edit', 'sequence', 'mixed', 'multi-step', 'leanctx', 'serena'],
    steps: [
      { service: 'leanctx', tool: 'ctx_read', args: {} },
      { service: 'serena', tool: 'find_symbol', args: {} },
      { service: 'serena', tool: 'replace_content', args: {} },
    ],
    riskTier: 'requires_review', // includes a write step
    handoffShape:
      'Ask the local LLM to run this exact ordered cross-service sequence: 1) ctx_read {path} (LeanCTX), 2) find_symbol {name_path_pattern} (Serena), 3) replace_content {relative_path, needle, repl, mode:"literal"} (Serena). Provide the file path, symbol, and replacement.',
  },
];

function main(): void {
  const force = process.argv.includes('--force');
  const store = new ProcedureStore();
  const dbPath = getDefaultProcedurePath();

  if (store.count() > 0 && !force) {
    console.error(`procedures table already has ${store.count()} rows at ${dbPath}`);
    console.error('Pass --force to clear and re-seed.');
    process.exitCode = 0;
    store.close();
    return;
  }
  if (force) {
    const removed = store.clear();
    console.log(`cleared ${removed} existing procedures`);
  }

  for (const procedure of SEED) {
    const id = store.seedProcedure(procedure);
    console.log(`seeded ${procedure.riskTier.padEnd(16)} ${procedure.triggerPattern} -> ${id}`);
  }

  console.log(`\n${store.count()} procedures in ${dbPath}`);
  store.close();
}

main();
