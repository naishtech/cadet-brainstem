import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MineStore, getDefaultMinePath } from '../src/mine/store';
import {
  inventorySource,
  parseJsonlFile,
  redactMessages,
  redactText,
} from '../src/mine/index';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'to-mine-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env.CADET_BRAINSTEM_MINE;
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_MINE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getDefaultMinePath', () => {
  it('is separate from the memory db (mine.db)', () => {
    expect(getDefaultMinePath()).toMatch(/\.cadet-brainstem[/\\]mine\.db$/);
  });

  it('honours the CADET_BRAINSTEM_MINE override', () => {
    process.env.CADET_BRAINSTEM_MINE = 'C:/custom/mine.db';
    expect(getDefaultMinePath()).toBe('C:/custom/mine.db');
  });
});

describe('redactText', () => {
  it('redacts credential patterns and counts them', () => {
    const text = 'token=abc123SECRETdef456 token2=SECRET';
    const { text: out, count } = redactText(text);
    expect(count).toBeGreaterThan(0);
    expect(out).not.toContain('abc123SECRETdef456');
  });

  it('redacts aws access keys and keeps the rest', () => {
    const { text: out, count } = redactText('key AKIAIOSFODNN7EXAMPLE keepme');
    expect(count).toBe(1);
    expect(out).toContain('[REDACTED:aws_access_key]');
    expect(out).toContain('keepme');
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    const { text: out, count } = redactText(`x ${pem} y`);
    expect(count).toBeGreaterThan(0);
    expect(out).not.toContain('MIIEvQIBADANBg');
  });
});

describe('parseJsonlFile', () => {
  it('parses kind 0/1/2 records into normalized messages', () => {
    const dir = makeTempDir();
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ kind: 0, v: { sessionId: 'sess-1', creationDate: 1787962918783 } }),
        JSON.stringify({ kind: 1, k: ['responderUsername'], v: 'GitHub Copilot' }),
        JSON.stringify({
          kind: 2,
          v: [
            {
              requestId: 'r1',
              message: { text: 'stage and commit' },
              response: { message: { content: [{ type: 'text', value: 'done' }] } },
            },
          ],
        }),
      ].join('\n'),
    );
    const parsed = parseJsonlFile(file, 'ws-1');
    expect(parsed.conversationId).toBe('sess-1');
    expect(parsed.timestamp).toBe('2026-08-29T00:21:58.783Z');
    expect(parsed.messages).toEqual([
      { role: 'user', text: 'stage and commit' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('handles kind:2 with v as a session snapshot containing requests', () => {
    const dir = makeTempDir();
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        kind: 2,
        v: {
          version: 3,
          requests: [{ message: { text: 'run the tests' }, response: { message: { text: 'ok' } } }],
        },
      }),
    );
    const parsed = parseJsonlFile(file, 'ws-1');
    expect(parsed.messages).toEqual([
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'ok' },
    ]);
  });

  it('extracts assistant text when response is an array of records', () => {
    const dir = makeTempDir();
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        kind: 2,
        v: [
          {
            message: { text: 'stage and commit' },
            response: [
              { message: { text: 'staged' } },
              { message: { content: [{ type: 'text', value: 'committed' }] } },
            ],
          },
        ],
      }),
    );
    const parsed = parseJsonlFile(file, 'ws-1');
    expect(parsed.messages).toEqual([
      { role: 'user', text: 'stage and commit' },
      { role: 'assistant', text: 'staged' },
      { role: 'assistant', text: 'committed' },
    ]);
  });
});

describe('inventorySource', () => {
  it('counts workspaces and jsonl files and reports a date range', () => {
    const root = makeTempDir();
    const ws = join(root, 'ws-a', 'chatSessions');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'a.jsonl'),
      JSON.stringify({ kind: 0, v: { creationDate: 1700000000000 } }),
    );
    writeFileSync(
      join(ws, 'b.jsonl'),
      JSON.stringify({ kind: 0, v: { creationDate: 1800000000000 } }),
    );

    const report = inventorySource(root);
    expect(report.workspaceCount).toBe(1);
    expect(report.jsonlCount).toBe(2);
    expect(report.dateRange.earliest).toBe('2023-11-14T22:13:20.000Z');
    expect(report.dateRange.latest).toBe('2027-01-15T08:00:00.000Z');
  });
});

describe('MineStore', () => {
  it('stores raw and review candidates separately from the live table', () => {
    const store = new MineStore(join(makeTempDir(), 'mine.db'));
    const rawId = store.saveRaw({
      sourceWorkspace: 'ws',
      conversationId: 'c1',
      timestamp: 't',
      messages: [{ role: 'user', text: 'stage and commit' }],
      redactions: 0,
    });
    expect(store.countRaw()).toBe(1);
    expect(store.updateRaw(rawId, [{ role: 'user', text: '[REDACTED:credential] commit' }], 2)).toBe(
      true,
    );
    expect(store.listRaw()[0]!.redactions).toBe(2);

    store.saveReview({
      sourceWorkspace: 'ws',
      sourceConversationId: 'c1',
      timestamp: 't',
      triggerPattern: 'stage and commit',
      keywords: ['commit'],
      steps: ['git add -A'],
      isProcedural: true,
      confidence: 0.9,
      redactions: 2,
    });
    expect(store.countReview()).toBe(1);
    const review = store.listReview()[0]!;
    expect(review.triggerPattern).toBe('stage and commit');
    expect(review.redactions).toBe(2);
    store.close();
  });
});

describe('redactMessages', () => {
  it('redacts across messages and reports a total', () => {
    const { messages, redactions } = redactMessages([
      { role: 'user', text: 'password=supersecretvalue123' },
      { role: 'assistant', text: 'ok' },
    ]);
    expect(redactions).toBeGreaterThan(0);
    expect(messages[0]!.text).not.toContain('supersecretvalue123');
  });
});
