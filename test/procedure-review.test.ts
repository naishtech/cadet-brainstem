import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWriteDiff } from '../src/procedure';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rev-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildWriteDiff', () => {
  it('produces a diff for create_text_file', () => {
    const proposal = buildWriteDiff(
      { service: 'serena', tool: 'create_text_file' },
      { relative_path: 'notes.md', content: 'alpha\nbeta' },
      dir,
    );
    expect(proposal.kind).toBe('create');
    expect(proposal.path).toBe('notes.md');
    expect(proposal.before).toBeNull();
    expect(proposal.after).toBe('alpha\nbeta');
    expect(proposal.diff).toContain('+alpha');
    expect(proposal.diff).toContain('+beta');
    expect(proposal.unsupported).toBe(false);
  });

  it('produces a diff for replace_content (literal) against a real file', () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    const proposal = buildWriteDiff(
      { service: 'serena', tool: 'replace_content' },
      { relative_path: 'a.ts', needle: 'const y = 2;', repl: 'const y = 3;', mode: 'literal' },
      dir,
    );
    expect(proposal.kind).toBe('edit');
    expect(proposal.before).toContain('const y = 2;');
    expect(proposal.after).toContain('const y = 3;');
    expect(proposal.diff).toContain('-const y = 2;');
    expect(proposal.diff).toContain('+const y = 3;');
    expect(proposal.unsupported).toBe(false);
  });

  it('marks unsupported write tools as unsupported (no diff)', () => {
    const proposal = buildWriteDiff(
      { service: 'serena', tool: 'insert_after_symbol' },
      { name_path: 'foo', relative_path: 'a.ts', body: 'x' },
      dir,
    );
    expect(proposal.unsupported).toBe(true);
    expect(proposal.diff).toBe('');
  });
});
