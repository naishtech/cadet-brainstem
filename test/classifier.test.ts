import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ClassificationValidationError,
  ClassifierUnavailableError,
  OllamaClassifier,
  buildPrompt,
  classify,
  isOllamaAvailable,
  parseClassification,
} from '../src/classifier/index';

const validClassification = {
  task: 'debug',
  complexity: 'medium',
  risk: 'medium',
  context_need: 'broad',
  precision: 'normal',
  tool_plan: { use: ['find_relevant_symbols'], skip: ['compress_command_output'] },
  response_policy: ['compact', 'no_filler'],
};

function mockFetchJson(body: unknown, ok = true, status = 200): Mock {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

function requestBodyOf(fetchMock: Mock): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.CADET_TOKEN_SAVER_CONFIG;
  vi.unstubAllGlobals();
});

describe('parseClassification', () => {
  it('parses a JSON string into a classification', () => {
    expect(parseClassification(JSON.stringify(validClassification))).toEqual(
      validClassification,
    );
  });

  it('accepts an already-parsed object', () => {
    expect(parseClassification(validClassification)).toEqual(validClassification);
  });

  it('rejects output with an invalid enum value', () => {
    expect(() =>
      parseClassification({ ...validClassification, task: 'not-a-task' }),
    ).toThrow(ClassificationValidationError);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseClassification('this is not json')).toThrow(
      ClassificationValidationError,
    );
  });

  it('fills defaults when tool_plan/response_policy are omitted', () => {
    const parsed = parseClassification({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
    });
    expect(parsed.tool_plan).toEqual({ use: [], skip: [] });
    expect(parsed.response_policy).toEqual([
      'compact',
      'no_filler',
      'no_repetition',
      'no_tool_narration',
    ]);
  });

  it('drops invalid tool_plan/response_policy entries instead of failing', () => {
    const parsed = parseClassification({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      tool_plan: {
        use: ['optimize_context', 'classify', 42, null],
        skip: ['bogus'],
      },
      response_policy: ['delta_only', 'not_a_directive', 7],
    });
    expect(parsed.tool_plan).toEqual({ use: ['optimize_context'], skip: [] });
    expect(parsed.response_policy).toEqual(['delta_only']);
  });

  it('captures confidence, needs_more_context, and retrieval when present', () => {
    const parsed = parseClassification({
      ...validClassification,
      confidence: 0.42,
      needs_more_context: true,
      retrieval: { queries: ['.serena', '.cadet'], scope: 'project root' },
    });
    expect(parsed.confidence).toBe(0.42);
    expect(parsed.needs_more_context).toBe(true);
    expect(parsed.retrieval).toEqual({
      queries: ['.serena', '.cadet'],
      scope: 'project root',
    });
  });

  it('normalizes retrieval scope strings', () => {
    const parsed = parseClassification({
      ...validClassification,
      retrieval: {
        queries: ['chat_memory'],
        scope: 'project_root+config +  memory implementation',
      },
    });
    expect(parsed.retrieval).toEqual({
      queries: ['chat_memory'],
      scope: 'project root + config + memory implementation',
    });
  });

  it('drops invalid confidence / needs_more_context / retrieval values', () => {
    const parsed = parseClassification({
      ...validClassification,
      confidence: 'high',
      needs_more_context: 'yes',
      retrieval: { queries: [42, null, 'x'], scope: 7 },
    });
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.needs_more_context).toBeUndefined();
    expect(parsed.retrieval).toEqual({ queries: ['x'] });
  });

  it('omits confidence/needs_more_context/retrieval when absent', () => {
    const parsed = parseClassification(validClassification);
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.needs_more_context).toBeUndefined();
    expect(parsed.retrieval).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('enforces the key classifier constraints', () => {
    const prompt = buildPrompt('fix the blueprint loader');
    expect(prompt).toContain('You are a fast, lightweight classifier');
    expect(prompt).toContain('You do NOT solve, answer,');
    expect(prompt).toContain('or explain the request. You ONLY classify it.');
    expect(prompt).toContain('Output ONLY valid JSON');
    expect(prompt).toContain('No markdown fences');
    expect(prompt).toContain('FIELD DEFINITIONS — use these exactly');
  });

  it('includes the user request text', () => {
    expect(buildPrompt('fix the blueprint loader')).toContain(
      'fix the blueprint loader',
    );
  });

  it('encourages planning/investigation rather than review for design work', () => {
    const prompt = buildPrompt('Design a new memory summarization workflow for the agent.');
    expect(prompt).toContain('Rule: requests to "design", "plan", "figure out how to approach", or');
    expect(prompt).toContain('NEVER review.');
  });

  it('renders custom external templates through Mustache', () => {
    const template = 'User request: {{{userRequest}}}\nTools: {{{tools}}}';
    const prompt = buildPrompt('Fix config loading', template);
    expect(prompt).toContain('User request: Fix config loading');
    expect(prompt).toContain('Tools: optimize_context, find_relevant_symbols, compress_command_output, chat_memory_store');
  });

  it('recommends prioritizing MCP tools over raw grep/file search', () => {
    const prompt = buildPrompt('Analyze a fresh trace with the toolchain.');
    expect(prompt).toContain('This classifier recommends that the downstream intelligence prioritize MCP tools over raw repo search, grep, or direct file inspection when possible.');
    expect(prompt).toContain('The final agent response should honor the recommended tool plan unless MCP tooling is unavailable.');
    expect(prompt).toContain('When the tool plan is essential, include follow_tool_plan');
  });
});

describe('classify', () => {
  it('returns a validated classification from Ollama JSON', async () => {
    const fetchMock = mockFetchJson({
      message: { content: JSON.stringify(validClassification) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await classify('fix the blueprint loader', {
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    expect(result).toEqual(validClassification);
  });

  it('sends the configured model and requests JSON format', async () => {
    const fetchMock = mockFetchJson({
      message: { content: JSON.stringify(validClassification) },
    });
    vi.stubGlobal('fetch', fetchMock);
    await classify('debug flaky test', {
      model: 'custom-model',
      host: 'http://localhost:11434',
    });
    const body = requestBodyOf(fetchMock);
    expect(body.model).toBe('custom-model');
    expect(body.format).toBe('json');
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.keep_alive).toBe('30m');
  });

  it('reads the model from config when not provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'to-class-'));
    const cfgFile = join(dir, 'config.yaml');
    writeFileSync(cfgFile, 'classifier:\n  model: config-model\n', 'utf8');
    process.env.CADET_TOKEN_SAVER_CONFIG = cfgFile;
    try {
      const fetchMock = mockFetchJson({
        message: { content: JSON.stringify(validClassification) },
      });
      vi.stubGlobal('fetch', fetchMock);
      await classify('hello', { host: 'http://localhost:11434' });
      expect(requestBodyOf(fetchMock).model).toBe('config-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads timeout_ms and keep_alive from config when not provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'to-class-'));
    const cfgFile = join(dir, 'config.yaml');
    writeFileSync(
      cfgFile,
      'classifier:\n  model: config-model\n  timeout_ms: 45000\n  keep_alive: 15m\n',
      'utf8',
    );
    process.env.CADET_TOKEN_SAVER_CONFIG = cfgFile;
    try {
      const fetchMock = mockFetchJson({
        message: { content: JSON.stringify(validClassification) },
      });
      vi.stubGlobal('fetch', fetchMock);
      await classify('hello', { host: 'http://localhost:11434' });
      const body = requestBodyOf(fetchMock);
      expect(body.model).toBe('config-model');
      expect(body.keep_alive).toBe('15m');
      const classifier = new OllamaClassifier({
        host: 'http://localhost:11434',
      });
      expect(classifier.timeoutMs).toBe(45000);
      expect(classifier.keepAlive).toBe('15m');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws ClassifierUnavailableError when Ollama is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      classify('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(ClassifierUnavailableError);
  });

  it('throws ClassifierUnavailableError on a non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetchJson({}, false, 500));
    await expect(
      classify('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(ClassifierUnavailableError);
  });

  it('throws ClassificationValidationError on invalid JSON output', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({ message: { content: JSON.stringify({ task: 'nope' }) } }),
    );
    await expect(
      classify('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(ClassificationValidationError);
  });
});

describe('isOllamaAvailable', () => {
  it('returns true when the tags endpoint responds OK', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ models: [] }));
    await expect(isOllamaAvailable('http://localhost:11434')).resolves.toBe(true);
  });

  it('returns false when Ollama is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    await expect(isOllamaAvailable('http://localhost:11434')).resolves.toBe(false);
  });
});

describe('OllamaClassifier', () => {
  it('classifies through the class API', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({ message: { content: JSON.stringify(validClassification) } }),
    );
    const classifier = new OllamaClassifier({
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    await expect(classifier.classify('refactor this')).resolves.toEqual(
      validClassification,
    );
  });

  it('reports availability', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ models: [] }));
    const classifier = new OllamaClassifier({
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    await expect(classifier.isAvailable()).resolves.toBe(true);
  });
});
