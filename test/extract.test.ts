import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractFromConversation, isPlausibleTrigger, normalizeConfidence } from '../src/mine/extract';

// Mock the local-LLM extraction so we can drive the filter deterministically.
vi.mock('../src/steering', () => ({
  extractProcedure: vi.fn(),
}));

import { extractProcedure } from '../src/steering';

const mockExtract = vi.mocked(extractProcedure);

const parsed = {
  sourceWorkspace: 'ws',
  conversationId: 'c1',
  timestamp: null,
  messages: [{ role: 'user' as const, text: 'do the thing' }],
};

beforeEach(() => {
  mockExtract.mockReset();
});

describe('normalizeConfidence', () => {
  it('keeps 0..1 as-is and divides 0..100 by 100', () => {
    expect(normalizeConfidence(0.8)).toBe(0.8);
    expect(normalizeConfidence(80)).toBe(0.8);
    expect(normalizeConfidence(100)).toBe(1);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
  });
});

describe('isPlausibleTrigger', () => {
  it('accepts short imperative procedure descriptions', () => {
    expect(isPlausibleTrigger('stage all changes, commit, open PR')).toBe(true);
    expect(isPlausibleTrigger('run the test suite and report results')).toBe(true);
  });

  it('rejects error messages, file refs, and bare identifiers', () => {
    expect(isPlausibleTrigger('BuildQueueJobStateServiceTests.cs(174,13): error CS8803')).toBe(false);
    expect(isPlausibleTrigger('Cancellation by user')).toBe(false);
    expect(isPlausibleTrigger('TryStartDetached_CommandExitNonZero_WritesFailedManifestWithExitCode')).toBe(false);
    expect(isPlausibleTrigger('UI rendering error')).toBe(false);
  });

  it('rejects too-short or empty triggers', () => {
    expect(isPlausibleTrigger('')).toBe(false);
    expect(isPlausibleTrigger('hi')).toBe(false);
  });
});

describe('extractFromConversation over-eager filter', () => {
  const good = {
    is_procedural: true,
    trigger_pattern: 'stage all changes, commit, open PR',
    keywords: ['commit'],
    steps: ['git add -A', 'git commit -m {message}'],
    confidence: 0.8,
  };

  it('accepts procedural with steps + plausible trigger + high confidence', async () => {
    mockExtract.mockResolvedValue(good as never);
    const result = await extractFromConversation(parsed);
    expect(result.isProcedural).toBe(true);
    expect(result.triggerPattern).toBe(good.trigger_pattern);
  });

  it('rejects procedural=true with no steps', async () => {
    mockExtract.mockResolvedValue({ ...good, steps: [] } as never);
    const result = await extractFromConversation(parsed);
    expect(result.isProcedural).toBe(false);
    expect(result.triggerPattern).toBe('');
  });

  it('rejects procedural=true with an implausible trigger', async () => {
    mockExtract.mockResolvedValue({
      ...good,
      trigger_pattern: 'BuildQueueJobStateServiceTests.cs(174,13): error CS8803',
    } as never);
    const result = await extractFromConversation(parsed);
    expect(result.isProcedural).toBe(false);
  });

  it('rejects procedural=true with low confidence', async () => {
    mockExtract.mockResolvedValue({ ...good, confidence: 0.2 } as never);
    const result = await extractFromConversation(parsed);
    expect(result.isProcedural).toBe(false);
  });

  it('rejects when the model says not procedural', async () => {
    mockExtract.mockResolvedValue({ ...good, is_procedural: false } as never);
    const result = await extractFromConversation(parsed);
    expect(result.isProcedural).toBe(false);
  });
});
