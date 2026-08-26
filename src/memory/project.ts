import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getDefaultMemoryPath } from './store';

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

/**
 * Resolve the project root for a working directory: the nearest ancestor
 * containing `package.json` or `.git`; falls back to the cwd itself.
 */
export function resolveProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(cwd);
    }
    dir = parent;
  }
}

/** Per-project memory db path (mirrors Serena's `.serena/` convention). */
export function getProjectMemoryPath(projectRoot: string): string {
  return join(projectRoot, '.cadet', 'token-saver', 'memory.db');
}

/** Resolve a project name or path to a project root (uses the config registry). */
export function resolveProjectRootFor(
  nameOrPath: string,
  cwd: string,
  projects: Record<string, string> | undefined = {},
): string {
  const asPath = resolve(nameOrPath);
  if (existsSync(asPath)) {
    return asPath;
  }
  const registered = projects?.[nameOrPath];
  if (registered !== undefined) {
    return resolve(registered);
  }
  return resolveProjectRoot(cwd);
}

/**
 * Resolve the memory db path for a scope: explicit `project`, the active
 * project, or the cwd-derived project. `__global__` uses the global db.
 */
export function resolveMemoryDbPath(
  cwd: string,
  project: string | undefined,
  activeProject: string | undefined,
  projects: Record<string, string> | undefined,
): string {
  const scope = project ?? activeProject;
  if (scope === GLOBAL_PROJECT) {
    return getDefaultMemoryPath();
  }
  if (scope !== undefined) {
    return getProjectMemoryPath(resolveProjectRootFor(scope, cwd, projects));
  }
  return getProjectMemoryPath(resolveProjectRoot(cwd));
}
