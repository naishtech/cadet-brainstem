import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  isOllamaAvailable,
  TASK_TYPES,
} from '../src/classifier';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const LIMIT = Number(process.env.CADET_CHAT_LIMIT ?? '5');

/**
 * Best-effort locate the most recent VS Code Copilot chat session log.
 * Prefers an explicit `CADET_CHAT_SESSION` path; otherwise scans the default
 * VS Code workspaceStorage chatSessions dirs for the newest `.jsonl`.
 */
function findLatestChatLog(): string | undefined {
  if (
    process.env.CADET_CHAT_SESSION &&
    existsSync(process.env.CADET_CHAT_SESSION)
  ) {
    return process.env.CADET_CHAT_SESSION;
  }
  const roots: string[] = [];
  if (process.env.APPDATA) {
    roots.push(join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage'));
  }
  if (process.platform !== 'win32') {
    roots.push(join(homedir(), '.config', 'Code', 'User', 'workspaceStorage'));
  }
  let best: { path: string; mtime: number } | undefined;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const ws of readdirSync(root)) {
      const dir = join(root, ws, 'chatSessions');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(dir, f);
        try {
          const m = statSync(p).mtimeMs;
          if (!best || m > best.mtime) best = { path: p, mtime: m };
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }
  return best?.path;
}

/** Extract real user prompt text from a Copilot chat session JSONL. */
function extractUserPrompts(file: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const r = rec as {
      kind?: number;
      v?: Array<{ message?: { text?: string } }>;
    };
    if (r.kind !== 2 || !Array.isArray(r.v)) continue;
    for (const req of r.v) {
      const text = req?.message?.text?.trim();
      if (!text || text.length < 4 || text.length > 4000) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const chatLog = findLatestChatLog();
const prompts = chatLog ? extractUserPrompts(chatLog, LIMIT) : [];
const ollamaUp = await isOllamaAvailable(HOST);
const run = ollamaUp && prompts.length > 0 ? describe : describe.skip;

run('classify on real chat prompts', () => {
  it('produces a schema-valid, non-degraded classification for each real user prompt', async () => {
    for (const prompt of prompts) {
      const result = await classify(prompt, { host: HOST, timeoutMs: 60_000 });
      // classify() runs parseClassification, so a resolved value is already
      // schema-valid. Assert the routing fields are present and sensible.
      expect(TASK_TYPES).toContain(result.task);
      expect(result.complexity).toBeDefined();
      expect(result.risk).toBeDefined();
      expect(result.context_need).toBeDefined();
      expect(Array.isArray(result.entities)).toBe(true);
    }
  }, 300_000);
});
