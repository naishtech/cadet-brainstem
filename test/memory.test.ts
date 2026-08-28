import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryStore,
  getDefaultMemoryPath,
  resolveMemoryDbPath,
  resolveProjectId,
} from '../src/memory/index';
import { runMemoryClear, runMemoryStats } from '../src/cli/commands/memory';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-memory-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.CADET_BRAINSTEM_MEMORY;
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_MEMORY;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getDefaultMemoryPath', () => {
  it('returns a stable default path', () => {
    expect(getDefaultMemoryPath()).toMatch(/\.cadet-brainstem[/\\]memory\.db$/);
  });

  it('honours the CADET_BRAINSTEM_MEMORY override', () => {
    process.env.CADET_BRAINSTEM_MEMORY = 'C:/custom/memory.db';
    expect(getDefaultMemoryPath()).toBe('C:/custom/memory.db');
  });
});

describe('resolveProjectId', () => {
  it('uses the package.json name when present', () => {
    const read = (p: string): string => {
      if (p.endsWith('package.json')) return '{"name":"my-app"}';
      throw new Error('not found');
    };
    expect(resolveProjectId('/x/my-app', read)).toBe('my-app');
  });

  it('falls back to the git origin remote', () => {
    const read = (p: string): string => {
      if (p.endsWith('package.json')) throw new Error('no pkg');
      if (p.endsWith('config')) {
        return '[remote "origin"]\n  url = https://github.com/acme/widget.git\n';
      }
      throw new Error('not found');
    };
    expect(resolveProjectId('/x/widget', read)).toBe('github.com/acme/widget');
  });

  it('falls back to <basename>-<hash> otherwise', () => {
    const read = (): string => {
      throw new Error('not found');
    };
    expect(resolveProjectId(join('x', 'no-pkg'), read)).toMatch(
      /^no-pkg-[0-9a-f]{8}$/,
    );
  });
});

describe('resolveMemoryDbPath', () => {
  it('returns the global db for __global__', () => {
    expect(
      resolveMemoryDbPath('/x', '__global__', undefined, undefined),
    ).toBe(getDefaultMemoryPath());
  });

  it('returns the per-project db for a project path', () => {
    const dir = makeTempDir();
    expect(resolveMemoryDbPath(process.cwd(), dir, undefined, undefined)).toBe(
      join(dir, '.cadet', 'brainstem', 'memory.db'),
    );
  });

  it('derives the project db from cwd when no scope is given', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}', 'utf8');
    expect(resolveMemoryDbPath(dir, undefined, undefined, undefined)).toBe(
      join(dir, '.cadet', 'brainstem', 'memory.db'),
    );
  });
});

describe('MemoryStore (in-memory)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('starts empty', () => {
    expect(store.count()).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.search()).toEqual([]);
    expect(store.get('missing')).toBeNull();
  });

  it('round-trips store -> get -> update -> delete', () => {
    const id = store.store({
      content: 'npm needs a shell on Windows',
      tags: ['windows', 'npm'],
      project: 'cadet-brainstem',
    });
    expect(id).toBeTruthy();

    const stored = store.get(id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe('npm needs a shell on Windows');
    expect(stored!.tags).toEqual(['windows', 'npm']);
    expect(stored!.project).toBe('cadet-brainstem');
    expect(stored!.hits).toBe(1);
    expect(stored!.lastAccessedAt).not.toBeNull();

    expect(store.update(id, { content: 'updated content' })).toBe(true);
    expect(store.update(id, { tags: ['updated'] })).toBe(true);

    const updated = store.get(id);
    expect(updated!.content).toBe('updated content');
    expect(updated!.tags).toEqual(['updated']);
    expect(updated!.hits).toBe(2);

    expect(store.delete(id)).toBe(true);
    expect(store.delete(id)).toBe(false);
    expect(store.count()).toBe(0);
  });

  it('get bumps hits and last-accessed on each access', () => {
    const id = store.store({ content: 'first' });
    const first = store.get(id);
    const second = store.get(id);
    expect(first!.hits).toBe(1);
    expect(second!.hits).toBe(2);
    expect(second!.lastAccessedAt).not.toBeNull();
  });

  it('update returns false for a missing id', () => {
    expect(store.update('missing', { content: 'x' })).toBe(false);
    expect(store.update('missing', {})).toBe(false);
  });

  it('search matches content substrings case-insensitively', () => {
    store.store({ content: 'Docker Desktop must be started' });
    store.store({ content: 'Unrelated note' });
    expect(store.search({ query: 'docker' })).toHaveLength(1);
    expect(store.search({ query: 'desktop' })[0]!.content).toBe(
      'Docker Desktop must be started',
    );
  });

  it('search scopes by project', () => {
    store.store({ content: 'a', project: 'proj-a' });
    store.store({ content: 'b', project: 'proj-b' });
    store.store({ content: 'c' });
    expect(store.search({ project: 'proj-a' })).toHaveLength(1);
    expect(store.search({ project: 'proj-a' })[0]!.content).toBe('a');
  });

  it('search scopes by tags (all requested tags must match)', () => {
    store.store({ content: 'a', tags: ['git', 'windows'] });
    store.store({ content: 'b', tags: ['git'] });
    store.store({ content: 'c', tags: ['windows'] });
    expect(store.search({ tags: ['git'] })).toHaveLength(2);
    expect(store.search({ tags: ['git', 'windows'] })).toHaveLength(1);
    expect(store.search({ tags: ['git', 'windows'] })[0]!.content).toBe('a');
  });

  it('list returns most recently updated first', () => {
    const a = store.store({ content: 'a' });
    const b = store.store({ content: 'b' });
    store.update(a, { content: 'a-updated' });
    const list = store.list();
    expect(list.map((m) => m.id)).toEqual([a, b]);
  });

  it('list scopes by project and honours limit', () => {
    store.store({ content: 'a', project: 'p' });
    store.store({ content: 'b', project: 'p' });
    store.store({ content: 'c', project: 'q' });
    expect(store.list({ project: 'p' })).toHaveLength(2);
    expect(store.list({ limit: 2 })).toHaveLength(2);
  });

  it('clear removes all memories and returns the count removed', () => {
    store.store({ content: 'a' });
    store.store({ content: 'b' });
    expect(store.clear()).toBe(2);
    expect(store.count()).toBe(0);
    expect(store.clear()).toBe(0);
  });

  it('count and clear can be scoped to a project', () => {
    store.store({ content: 'a', project: 'p1' });
    store.store({ content: 'b', project: 'p1' });
    store.store({ content: 'c', project: 'p2' });
    expect(store.count()).toBe(3);
    expect(store.count('p1')).toBe(2);
    expect(store.clear('p1')).toBe(2);
    expect(store.count()).toBe(1);
    expect(store.count('p2')).toBe(1);
  });
});

describe('MemoryStore (file-backed)', () => {
  it('creates the database file on first use', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'memory.db');
    const store = new MemoryStore(dbPath);
    store.store({ content: 'persisted' });
    store.close();
    const reopened = new MemoryStore(dbPath);
    expect(reopened.count()).toBe(1);
    expect(reopened.search({ query: 'persisted' })).toHaveLength(1);
    reopened.close();
  });

  it('honours the CADET_BRAINSTEM_MEMORY override end to end', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'memory.db');
    process.env.CADET_BRAINSTEM_MEMORY = dbPath;
    const store = new MemoryStore();
    store.store({ content: 'via-env' });
    store.close();
    const reopened = new MemoryStore(getDefaultMemoryPath());
    expect(reopened.count()).toBe(1);
    reopened.close();
  });
});

describe('runMemoryClear', () => {
  function seed(dbPath: string, n: number, project = 'test-project'): void {
    const store = new MemoryStore(dbPath);
    for (let i = 0; i < n; i += 1) {
      store.store({ content: `memory ${i}`, project });
    }
    store.close();
  }

  it('clears memories after confirmation and reports the count', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    seed(dbPath, 2);
    const lines: string[] = [];

    const exit = await runMemoryClear({
      memoryPath: dbPath,
      project: 'test-project',
      ask: async () => true,
      log: (line) => lines.push(line),
    });

    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('Cleared 2 memory entries.');
    const reopened = new MemoryStore(dbPath);
    expect(reopened.count()).toBe(0);
    reopened.close();
  });

  it('--global clears the store after confirmation', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    const store = new MemoryStore(dbPath);
    store.store({ content: 'a', project: 'p1' });
    store.store({ content: 'b', project: 'p2' });
    store.close();

    const lines: string[] = [];
    const exit = await runMemoryClear({
      memoryPath: dbPath,
      global: true,
      ask: async () => true,
      log: (line) => lines.push(line),
    });

    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('Project: global');
    expect(lines.join('\n')).toContain('Cleared 2 memory entries.');
    const reopened = new MemoryStore(dbPath);
    expect(reopened.count()).toBe(0);
    reopened.close();
  });

  it('leaves memories intact when confirmation is declined', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    seed(dbPath, 2);
    const lines: string[] = [];

    const exit = await runMemoryClear({
      memoryPath: dbPath,
      project: 'test-project',
      ask: async () => false,
      log: (line) => lines.push(line),
    });

    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('Aborted');
    const reopened = new MemoryStore(dbPath);
    expect(reopened.count()).toBe(2);
    reopened.close();
  });

  it('defaults to no (no data loss) when non-interactive', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    seed(dbPath, 2);
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => false,
    });
    try {
      const exit = await runMemoryClear({
        memoryPath: dbPath,
        project: 'test-project',
        log: (line) => lines.push(line),
      });
      expect(exit).toBe(0);
    } finally {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
      consoleSpy.mockRestore();
    }
    expect(lines.join('\n')).toContain('Aborted');
    const reopened = new MemoryStore(dbPath);
    expect(reopened.count()).toBe(2);
    reopened.close();
  });
});

describe('runMemoryStats', () => {
  it('shows the memory count and database size for the project', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    const seedStore = new MemoryStore(dbPath);
    seedStore.store({ content: 'a', project: 'test-project' });
    seedStore.store({ content: 'b', project: 'test-project' });
    seedStore.close();

    const lines: string[] = [];
    const exit = await runMemoryStats({
      memoryPath: dbPath,
      project: 'test-project',
      log: (line) => lines.push(line),
    });
    const out = lines.join('\n');

    expect(exit).toBe(0);
    expect(out).toContain('Cadet Brainstem Memory');
    expect(out).toContain('Project: test-project');
    expect(out).toContain('Memories: 2');
    expect(out).toMatch(/Size:\s+\d+(\.\d+)? (B|KB|MB)/);
  });

  it('reports no memories when the database is absent', async () => {
    const dbPath = join(makeTempDir(), 'memory.db');
    const lines: string[] = [];
    const exit = await runMemoryStats({
      memoryPath: dbPath,
      project: 'test-project',
      log: (line) => lines.push(line),
    });
    expect(exit).toBe(0);
    expect(lines.join('\n')).toContain('No memories stored yet.');
  });
});
