import { describe, expect, it } from 'vitest';
import { sseComment, sseFrame } from '../src/dashboard/stream';

describe('SSE serialization', () => {
  it('serializes a named event with JSON data', () => {
    expect(sseFrame('status', { ts: 1, services: [] })).toBe(
      'event: status\ndata: {"ts":1,"services":[]}\n\n',
    );
  });

  it('serializes a heartbeat comment', () => {
    expect(sseComment('heartbeat')).toBe(': heartbeat\n\n');
  });
});
