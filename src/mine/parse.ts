import { readFileSync } from 'node:fs';
import type { RawConversation } from './store';

/** A message extracted from a JSONL chat transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Normalized conversation from a single `chatSessions/*.jsonl` file. */
export interface ParsedConversation {
  sourceWorkspace: string;
  conversationId: string;
  timestamp: string | null;
  messages: ChatMessage[];
}

/** Pull readable text out of a VS Code Copilot chat message object. */
function messageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message === null || typeof message !== 'object') {
    return '';
  }
  const m = message as Record<string, unknown>;
  if (typeof m.text === 'string') {
    return m.text;
  }
  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const part of m.content) {
      if (part === null || typeof part !== 'object') {
        continue;
      }
      const p = part as Record<string, unknown>;
      const value = typeof p.text === 'string' ? p.text : typeof p.value === 'string' ? p.value : '';
      if (value.length > 0) {
        parts.push(value);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** Collect requests from a `kind:2` record's `v` (array or session snapshot). */
function requestsFromValue(v: unknown): unknown[] {
  if (Array.isArray(v)) {
    return v;
  }
  if (v !== null && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).requests)) {
    return (v as Record<string, unknown>).requests as unknown[];
  }
  return [];
}

/** Parse one `chatSessions/*.jsonl` file into a normalized conversation. */
export function parseJsonlFile(
  filePath: string,
  sourceWorkspace: string,
  conversationIdFallback?: string,
): ParsedConversation {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  let sessionId = conversationIdFallback;
  let creationDate: string | null = null;
  const messages: ChatMessage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }
    if (record === null || typeof record !== 'object') {
      continue;
    }
    const rec = record as Record<string, unknown>;
    const kind = rec.kind;
    const v = rec.v;

    if (kind === 0 && v !== null && typeof v === 'object') {
      const meta = v as Record<string, unknown>;
      if (typeof meta.sessionId === 'string') {
        sessionId = meta.sessionId;
      }
      if (typeof meta.creationDate === 'number') {
        creationDate = new Date(meta.creationDate).toISOString();
      }
      continue;
    }

    if (kind !== 2) {
      continue;
    }

    for (const request of requestsFromValue(v)) {
      if (request === null || typeof request !== 'object') {
        continue;
      }
      const req = request as Record<string, unknown>;
      if (req.message) {
        const text = messageText(req.message).trim();
        if (text.length > 0) {
          messages.push({ role: 'user', text });
        }
      }
      const response = req.response;
      if (response !== null && typeof response === 'object') {
        // `response` is an array of response records (not a single object).
        const responseList = Array.isArray(response) ? response : [response];
        for (const resp of responseList) {
          if (resp === null || typeof resp !== 'object') {
            continue;
          }
          const respRec = resp as Record<string, unknown>;
          const respMessage = respRec.message;
          if (respMessage) {
            const text = messageText(respMessage).trim();
            if (text.length > 0) {
              messages.push({ role: 'assistant', text });
            }
          }
        }
      }
    }
  }

  return {
    sourceWorkspace,
    conversationId: sessionId ?? conversationIdFallback ?? 'unknown',
    timestamp: creationDate,
    messages,
  };
}

/** Convenience: adapt a ParsedConversation to the store's RawConversation. */
export function toRawConversation(parsed: ParsedConversation): Omit<RawConversation, 'id'> {
  return {
    sourceWorkspace: parsed.sourceWorkspace,
    conversationId: parsed.conversationId,
    timestamp: parsed.timestamp,
    messages: parsed.messages,
    redactions: 0,
  };
}

/** Rebuild a ParsedConversation from a stored (scrubbed) raw conversation. */
export function rawToParsed(raw: RawConversation): ParsedConversation {
  return {
    sourceWorkspace: raw.sourceWorkspace,
    conversationId: raw.conversationId,
    timestamp: raw.timestamp,
    messages: raw.messages,
  };
}

/** Flatten a conversation's messages into a single text block for extraction. */
export function conversationToText(parsed: ParsedConversation, maxChars = 6000): string {
  const parts: string[] = [];
  let used = 0;
  for (const msg of parsed.messages) {
    const label = msg.role === 'user' ? 'USER' : 'ASSISTANT';
    const block = `[${label}]\n${msg.text}`;
    if (used + block.length > maxChars && parts.length > 0) {
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}
