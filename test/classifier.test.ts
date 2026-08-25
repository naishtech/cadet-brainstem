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
};

function mockFetchJson(body: unknown, ok = true, status = 200): Mock {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

function requestBodyOf(fetchMock: Mock): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

afterEach(() => {
  delete process.env.TOKEN_OPTIMIZER_CONFIG;
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
});

describe('buildPrompt', () => {
  it('enforces the five classifier constraints', () => {
    const prompt = buildPrompt('fix the blueprint loader');
    expect(prompt).toContain('classify only');
    expect(prompt).toContain('do not solve');
    expect(prompt).toContain('return JSON only');
    expect(prompt).toContain('do not invent');
    expect(prompt).toContain('conservative');
  });

  it('includes the user request text', () => {
    expect(buildPrompt('fix the blueprint loader')).toContain(
      'fix the blueprint loader',
    );
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
  });

  it('reads the model from config when not provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'to-class-'));
    const cfgFile = join(dir, 'config.yaml');
    writeFileSync(cfgFile, 'classifier:\n  model: config-model\n', 'utf8');
    process.env.TOKEN_OPTIMIZER_CONFIG = cfgFile;
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
