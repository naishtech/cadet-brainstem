/**
 * Node emits an ExperimentalWarning the first time the built-in `node:sqlite`
 * module is loaded:
 *
 *   (node:27944) ExperimentalWarning: SQLite is an experimental feature and
 *   might change at any time
 *
 * We deliberately use `node:sqlite` (see `metrics/store.ts` and
 * `memory/store.ts`), so this warning is expected, harmless noise on every
 * CLI/MCP invocation. This module filters out exactly that one warning without
 * suppressing any other warnings (deprecations, etc.).
 *
 * IMPORTANT: this module MUST be the FIRST import in the CLI entry point so
 * the patch is in place before any transitively-imported module loads
 * `node:sqlite` (ESM evaluates dependencies in source order).
 */
type EmitWarning = typeof process.emitWarning;
const originalEmitWarning = process.emitWarning.bind(process);

const patchedEmitWarning = function (
  warning: string | Error,
  ...args: unknown[]
): void {
  const opts =
    args[0] && typeof args[0] === 'object'
      ? (args[0] as { type?: string; name?: string })
      : undefined;
  const type =
    typeof args[0] === 'string' ? args[0] : (opts?.type ?? opts?.name);
  const message =
    typeof warning === 'string' ? warning : warning.message;

  if (type === 'ExperimentalWarning' && message.includes('SQLite')) {
    return;
  }
  (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
} as unknown as EmitWarning;

process.emitWarning = patchedEmitWarning;
