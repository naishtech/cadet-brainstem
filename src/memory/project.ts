import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Explicit scope for memories shared across all projects. */
export const GLOBAL_PROJECT = '__global__';

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * Resolve a stable project id from a working directory:
 * 1. `package.json` `name`
 * 2. the git origin remote url (normalised)
 * 3. `<basename>-<hash8>` fallback (stable but not readable)
 *
 * Deterministic for the same cwd. Reads files only — never shells out.
 */
export function resolveProjectId(
  cwd: string,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  try {
    const pkg = JSON.parse(read(join(cwd, 'package.json'))) as { name?: string };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      return pkg.name;
    }
  } catch {
    // no package.json
  }

  try {
    const config = read(join(cwd, '.git', 'config'));
    const match = /\[remote "origin"\]\s*\n\s*url\s*=\s*(.+)/.exec(config);
    if (match !== null && match[1] !== undefined) {
      const url = match[1]
        .trim()
        .replace(/\.git$/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^git@/, '')
        .replace(/:/g, '/');
      if (url.length > 0) {
        return url;
      }
    }
  } catch {
    // no git config
  }

  return `${basename(cwd)}-${shortHash(cwd)}`;
}
