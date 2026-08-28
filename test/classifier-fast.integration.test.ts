import { describe, expect, it } from 'vitest';
import {
  classify,
  isModelAvailable,
  isOllamaAvailable,
  TASK_TYPES,
} from '../src/classifier';
import {
  FAST_CLASSIFIER_BASE_MODEL,
  FAST_CLASSIFIER_MODEL,
} from '../src/core/modelfile';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/**
 * Real-Ollama integration test for the Modelfile-derived `fast-classifier`.
 *
 * Unlike the mocked unit tests in `classifier.test.ts`, this hits the actual
 * Ollama server. It is skipped automatically (shown as `skipped`, not a pass)
 * when Ollama is down or the derived model has not been built, so it is safe to
 * run in CI and on machines without the local model.
 */
const ollamaUp = await isOllamaAvailable(HOST);
const fastPresent = ollamaUp && (await isModelAvailable(FAST_CLASSIFIER_MODEL, HOST));
const describeIt = fastPresent ? describe : describe.skip;

describeIt('fast-classifier (real Ollama)', () => {
  // A real classify can take ~7s on cold model load, so override vitest's
  // default 5s test timeout.
  it(
    'classifies a request into a schema-valid classification',
    async () => {
      const result = await classify('merge the open PR on the auth branch', {
        model: FAST_CLASSIFIER_MODEL,
        host: HOST,
        timeoutMs: 60_000,
      });
      // classify() already ran parseClassification (schema validation), so a
      // resolved value is schema-valid. Assert the core routing fields exist.
      expect(TASK_TYPES).toContain(result.task);
      expect(result.complexity).toBeDefined();
      expect(result.risk).toBeDefined();
    },
    60_000,
  );

  it(
    'reports the fast-classifier and base model as available',
    async () => {
      await expect(isModelAvailable(FAST_CLASSIFIER_MODEL, HOST)).resolves.toBe(true);
      await expect(isModelAvailable(FAST_CLASSIFIER_BASE_MODEL, HOST)).resolves.toBe(true);
    },
    20_000,
  );
});
