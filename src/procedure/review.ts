/**
 * Review-diff tool (task 49): produce a concrete, reviewable diff of what a
 * write step will change in a real repo — BEFORE it is applied. The cloud LLM /
 * user reviews this diff; only on approval is the change executed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcedureStep } from './schema';

export type WriteKind = 'create' | 'edit';

export interface WriteProposal {
  step: ProcedureStep;
  args: Record<string, unknown>;
  /** Repo-relative target path. */
  path: string;
  kind: WriteKind;
  /** Unified-ish diff (before -> after). Empty for unsupported tools. */
  diff: string;
  before: string | null;
  after: string;
  /** True when the tool is not supported by the reviewer (diff unavailable). */
  unsupported: boolean;
}

/** Reduce a path-like arg to a repo-relative path. */
function reducePath(value: unknown): string {
  return String(value ?? '').replace(/^[A-Za-z]:[\\/]/, '').replace(/^[\\/]+/, '').replace(/[\\]+/g, '/');
}

/** Simple line diff: common prefix/suffix kept as context, middle shown as -/+. */
function diffLines(beforeLines: string[], afterLines: string[]): string {
  let p = 0;
  while (
    p < beforeLines.length &&
    p < afterLines.length &&
    beforeLines[p] === afterLines[p]
  ) {
    p += 1;
  }
  let s = 0;
  while (
    s < beforeLines.length - p &&
    s < afterLines.length - p &&
    beforeLines[beforeLines.length - 1 - s] === afterLines[afterLines.length - 1 - s]
  ) {
    s += 1;
  }
  const midBefore = beforeLines.slice(p, beforeLines.length - s);
  const midAfter = afterLines.slice(p, afterLines.length - s);
  const lines: string[] = [];
  if (p > 0) lines.push(' ' + beforeLines[p - 1]);
  for (const l of midBefore) lines.push('-' + l);
  for (const l of midAfter) lines.push('+' + l);
  if (s > 0) lines.push(' ' + beforeLines[beforeLines.length - s]);
  return lines.join('\n');
}

function diffFor(kind: WriteKind, path: string, before: string | null, after: string): string {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (kind === 'create') {
    const added = after.split('\n').map((l) => '+' + l).join('\n');
    return `${header}@@ -0,0 +1,${after.split('\n').length} @@\n${added}`;
  }
  const body = diffLines((before ?? '').split('\n'), after.split('\n'));
  return `${header}@@ diff @@\n${body}`;
}

/** Normalize a path arg to a repo-relative path. */
function targetPath(args: Record<string, unknown>): string {
  return reducePath(args.relative_path ?? args.path ?? args.file_name ?? args.file);
}

/**
 * Build the review proposal (diff) for a single write step against a real repo.
 * Supports `replace_content` (literal) and `create_text_file`; other write
 * tools are marked `unsupported` (no diff — apply directly under review).
 */
export function buildWriteDiff(
  step: ProcedureStep,
  args: Record<string, unknown>,
  repoPath: string,
): WriteProposal {
  const path = targetPath(args);

  if (step.tool === 'create_text_file') {
    const after = String(args.content ?? '');
    return {
      step, args, path, kind: 'create', before: null, after,
      diff: diffFor('create', path, null, after),
      unsupported: false,
    };
  }

  if (step.tool === 'replace_content') {
    const file = join(repoPath, path);
    if (!existsSync(file)) {
      return { step, args, path, kind: 'edit', before: null, after: '', diff: '', unsupported: true };
    }
    const before = readFileSync(file, 'utf8');
    const needle = String(args.needle ?? '');
    const repl = String(args.repl ?? '');
    // literal single replace
    const idx = before.indexOf(needle);
    const after = idx >= 0 ? before.slice(0, idx) + repl + before.slice(idx + needle.length) : before;
    return {
      step, args, path, kind: 'edit', before, after,
      diff: diffFor('edit', path, before, after),
      unsupported: false,
    };
  }

  return { step, args, path, kind: 'edit', before: null, after: '', diff: '', unsupported: true };
}
