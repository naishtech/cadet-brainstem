import type { ChatMessage } from './parse';

/**
 * Secret detection/redaction (Step 1.3).
 *
 * Runs BEFORE any procedure extraction. There is no secrets-scanning dependency
 * in this repo (deps are only @modelcontextprotocol/sdk, mustache, yaml, zod),
 * so regex-based detection is written here. Replace detected secrets with a
 * fixed placeholder — never delete the message.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
}

const REDACTION_RULES: RedactionRule[] = [
  // AWS access key id / secret.
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'aws_secret', pattern: /(?:aws_secret_access_key|aws_secret_key|secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  // GitHub / generic tokens with well-known prefixes.
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Generic key/token/secret/password = <value> (assume any non-trivial value).
  { name: 'credential', pattern: /([a-zA-Z0-9_.-]*(?:key|token|secret|password|passwd|pwd|credential|api[_-]?key|client[_-]?secret))\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{12,})["']?/gi },
  // Connection strings with embedded credentials.
  { name: 'connection_string', pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s]+@/gi },
  // PEM private keys.
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // High-entropy hex/base64 after a bare `=` in common config (heuristic).
  { name: 'high_entropy', pattern: /\b(?:eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/]{40,}={0,2})\b/g },
];

/** Redact one message; returns the scrubbed text and how many hits were found. */
export function redactText(text: string): { text: string; count: number } {
  let result = text;
  let count = 0;
  for (const rule of REDACTION_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, () => {
      count += 1;
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text: result, count };
}

/** Redact a conversation's messages; returns new messages + total redactions. */
export function redactMessages(
  messages: ChatMessage[],
): { messages: ChatMessage[]; redactions: number } {
  let total = 0;
  const scrubbed: ChatMessage[] = [];
  for (const msg of messages) {
    const { text, count } = redactText(msg.text);
    total += count;
    scrubbed.push({ role: msg.role, text });
  }
  return { messages: scrubbed, redactions: total };
}
