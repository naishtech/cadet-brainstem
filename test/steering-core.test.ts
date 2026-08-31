import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  STEERING_JSON_SCHEMA,
  SteeringValidationError,
  SteeringUnavailableError,
  OllamaSteerer,
  buildPrompt,
  steer,
  isOllamaAvailable,
  parseSteering,
} from '../src/steering/index';

const validSteering = {
  task: 'debug',
  complexity: 'medium',
  risk: 'medium',
  context_need: 'broad',
  precision: 'normal',
  entities: ['checkout', 'payment'],
    tool_plan: {
    recommended_tools: [
      { name: 'find_relevant_symbols', intent: 'locate relevant symbols', priority: 1 },
    ],
  },
  response_policy: { directives: ['compact', 'no_filler'] },
};

function mockFetchJson(body: unknown, ok = true, status = 200): Mock {
  return vi.fn(async () => ({ ok, status, json: async () => body }));
}

function requestBodyOf(fetchMock: Mock): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  // Isolate from any real user config so loadConfig() returns defaults for
  // tests that don't set their own config explicitly.
  process.env.CADET_BRAINSTEM_CONFIG = join(tmpdir(), `cts-class-noconfig-${process.pid}.yaml`);
});

afterEach(() => {
  delete process.env.CADET_BRAINSTEM_CONFIG;
  vi.unstubAllGlobals();
});

describe('parseSteering', () => {
  it('parses a JSON string into a steering', () => {
    expect(parseSteering(JSON.stringify(validSteering))).toEqual(
      validSteering,
    );
  });

  it('accepts an already-parsed object', () => {
    expect(parseSteering(validSteering)).toEqual(validSteering);
  });

  it('rejects output with an invalid enum value', () => {
    expect(() =>
      parseSteering({ ...validSteering, task: 'not-a-task' }),
    ).toThrow(SteeringValidationError);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseSteering('this is not json')).toThrow(
      SteeringValidationError,
    );
  });

  it('fills defaults when tool_plan/response_policy are omitted', () => {
    const parsed = parseSteering({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      entities: [],
    });
    expect(parsed.tool_plan).toEqual({});
    expect(parsed.response_policy).toEqual({
      directives: ['compact', 'no_filler', 'no_repetition', 'no_tool_narration'],
    });
  });

  it('drops invalid tool_plan/response_policy entries instead of failing', () => {
    const parsed = parseSteering({
      task: 'debug',
      complexity: 'medium',
      risk: 'medium',
      context_need: 'broad',
      precision: 'normal',
      entities: [],
      tool_plan: {
        use: ['optimize_context', 'steering', 42, null],
      },
      response_policy: ['delta_only', 'not_a_directive', 7],
    });
    // Legacy flat `use` array is folded into recommended_tools (backward compat).
    expect(parsed.tool_plan).toEqual({
      recommended_tools: [
        {
          name: 'optimize_context',
          intent: 'extract and compress the relevant file context',
          priority: 1,
        },
      ],
    });
    expect(parsed.response_policy).toEqual({ directives: ['delta_only'] });
  });

  it('accepts a legacy flat-array response_policy as directives', () => {
    const parsed = parseSteering({
      ...validSteering,
      response_policy: ['compact', 'delta_only'],
    });
    expect(parsed.response_policy).toEqual({ directives: ['compact', 'delta_only'] });
  });

  it('dedupes repeated directives instead of preserving duplicates', () => {
    const parsed = parseSteering({
      ...validSteering,
      response_policy: {
        directives: [
          'follow_tool_plan',
          'preserve_evidence',
          'preserve_evidence',
          'preserve_evidence',
        ],
      },
    });
    expect(parsed.response_policy.directives).toEqual([
      'follow_tool_plan',
      'preserve_evidence',
    ]);
  });

  it('captures confidence, needs_more_context, and retrieval when present', () => {
    const parsed = parseSteering({
      ...validSteering,
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

  it('parses optional memory field when present', () => {
    const parsed = parseSteering({
      ...validSteering,
      memory: { use: true, reason: 'previous decision: prefer-leanctx' },
    });
    expect(parsed.memory).toEqual({ use: true, reason: 'previous decision: prefer-leanctx' });
  });

  it('parses memory use = "if_necessary" when present', () => {
    const parsed = parseSteering({
      ...validSteering,
      memory: { use: 'if_necessary', reason: 'may help during search' },
    });
    expect(parsed.memory).toEqual({ use: 'if_necessary', reason: 'may help during search' });
  });

  it('normalizes retrieval scope strings', () => {
    const parsed = parseSteering({
      ...validSteering,
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
    const parsed = parseSteering({
      ...validSteering,
      confidence: 'high',
      needs_more_context: 'yes',
      retrieval: { queries: [42, null, 'x'], scope: 7 },
    });
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.needs_more_context).toBeUndefined();
    expect(parsed.retrieval).toEqual({ queries: ['x'] });
  });

  it('omits confidence/needs_more_context/retrieval when absent', () => {
    const parsed = parseSteering(validSteering);
    expect(parsed.confidence).toBeUndefined();
    expect(parsed.needs_more_context).toBeUndefined();
    expect(parsed.retrieval).toBeUndefined();
  });

  it('captures guidance and evidence_plan when present', () => {
    const parsed = parseSteering({
      ...validSteering,
      guidance:
        'Advisory: compare overrides between A and B; verify before concluding.',
      evidence_plan: {
        prioritized_queries: [
          {
            id: 'q1',
            query: 'BP_Koala overrides',
            reason: 'find canonical overrides',
            sources: ['serena', 'file_search'],
            cost_estimate: 'cheap',
            fallback: ['q2'],
          },
          { id: 'q2', query: 'override table', sources: ['serena'] },
        ],
        scope: 'reference blueprint',
      },
    });
    expect(parsed.guidance).toBe(
      'Advisory: compare overrides between A and B; verify before concluding.',
    );
    expect(parsed.evidence_plan).toEqual({
      prioritized_queries: [
        {
          id: 'q1',
          query: 'BP_Koala overrides',
          reason: 'find canonical overrides',
          sources: ['serena', 'file_search'],
          cost_estimate: 'cheap',
          fallback: ['q2'],
        },
        { id: 'q2', query: 'override table', sources: ['serena'] },
      ],
      scope: 'reference blueprint',
    });
  });

  it('synthesizes evidence_plan from the legacy retrieval alias', () => {
    const parsed = parseSteering({
      ...validSteering,
      retrieval: { queries: ['.serena', '.cadet'], scope: 'project root' },
    });
    expect(parsed.retrieval).toEqual({
      queries: ['.serena', '.cadet'],
      scope: 'project root',
    });
    expect(parsed.evidence_plan).toEqual({
      prioritized_queries: [
        {
          id: 'q1',
          query: '.serena',
          sources: ['serena', 'file_search'],
          cost_estimate: 'cheap',
        },
        {
          id: 'q2',
          query: '.cadet',
          sources: ['serena', 'file_search'],
          cost_estimate: 'cheap',
        },
      ],
      scope: 'project root',
    });
  });

  it('keeps recommended_tools and drops invalid entries', () => {
    const parsed = parseSteering({
      ...validSteering,
      tool_plan: {
        use: ['optimize_context'],
        recommended_tools: [
          { name: 'optimize_context', intent: 'extract context', priority: 2 },
          { name: 'not_a_tool', intent: 'x', priority: 1 },
          { name: 'compress_command_output', priority: 'high' },
        ],
      },
    });
    expect(parsed.tool_plan).toEqual({
      recommended_tools: [
        { name: 'optimize_context', intent: 'extract context', priority: 2 },
        {
          name: 'compress_command_output',
          intent: 'compress noisy command output for cheap analysis',
          priority: 0,
        },
      ],
    });
  });

  it('omits guidance/evidence_plan when absent', () => {
    const parsed = parseSteering(validSteering);
    expect(parsed.guidance).toBeUndefined();
    expect(parsed.evidence_plan).toBeUndefined();
  });

  it('captures a valid nested language_standard when present', () => {
    const parsed = parseSteering({
      ...validSteering,
      response_policy: { directives: ['compact'], language_standard: 'asd_ste100' },
    });
    expect(parsed.response_policy.language_standard).toBe('asd_ste100');
    expect(parsed.response_policy.directives).toEqual(['compact']);
  });

  it('drops an invalid language_standard and omits it when absent', () => {
    const parsed = parseSteering({
      ...validSteering,
      response_policy: { directives: ['compact'], language_standard: 'chicago' },
    });
    expect(parsed.response_policy.language_standard).toBeUndefined();
    expect(parseSteering(validSteering).response_policy.language_standard).toBeUndefined();
  });

  it('captures reminders and subtasks when present', () => {
    const parsed = parseSteering({
      ...validSteering,
      reminders: [
        { tool: 'rtk', message: 'Use RTK for git output' },
        { tool: 'leanctx', message: 'Use LeanCTX for shell output' },
      ],
      subtasks: ['coding_new', 'configuration', 'coding_new'],
    });
    expect(parsed.reminders).toEqual([
      { tool: 'rtk', message: 'Use RTK for git output' },
      { tool: 'leanctx', message: 'Use LeanCTX for shell output' },
    ]);
    expect(parsed.subtasks).toEqual(['coding_new', 'configuration']);
  });

  it('derives guidance from the first reminder when guidance is absent', () => {
    const parsed = parseSteering({
      ...validSteering,
      reminders: [{ tool: 'rtk', message: 'Use RTK for git output' }],
    });
    expect(parsed.guidance).toBe('Use RTK for git output');
  });

  it('drops invalid reminders/subtasks entries', () => {
    const parsed = parseSteering({
      ...validSteering,
      reminders: [
        { tool: '', message: 'x' },
        { tool: 'rtk', message: 'ok' },
        (7 as unknown) as { tool: string; message: string },
      ],
      subtasks: ['coding_new', 'not_a_task', (42 as unknown) as never],
    });
    expect(parsed.reminders).toEqual([{ tool: 'rtk', message: 'ok' }]);
    expect(parsed.subtasks).toEqual(['coding_new']);
  });
});

describe('buildPrompt', () => {
  it('enforces the key steering constraints', () => {
    const prompt = buildPrompt('fix the blueprint loader');
    expect(prompt).toContain('You are a fast, lightweight routing steerer');
    expect(prompt).toContain('Do NOT solve');
    expect(prompt).toContain('do NOT invent repository facts');
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
    const template = 'User request: {{{userRequest}}}';
    const prompt = buildPrompt('Fix config loading', template);
    expect(prompt).toContain('User request: Fix config loading');
  });

  it('teaches steering + entity extraction, NOT tool/evidence selection', () => {
    const prompt = buildPrompt('document the blueprints and X300 code');
    expect(prompt).toContain('entities');
    expect(prompt).toContain('simple EXTRACTION, NOT reasoning');
    expect(prompt).toContain('do NOT suggest tools');
    // The model must NOT be asked to reason about tools or retrieval.
    expect(prompt).not.toContain('recommended_tools');
    expect(prompt).not.toContain('evidence_plan');
    expect(prompt).not.toContain('tool_plan');
    expect(prompt).not.toContain('response_policy');
  });

  it('defines the steering fields', () => {
    const prompt = buildPrompt('Design a new workflow.');
    expect(prompt).toContain('task (pick ONE)');
    expect(prompt).toContain('complexity (pick ONE)');
    expect(prompt).toContain('risk (pick ONE)');
    expect(prompt).toContain('context_need (pick ONE)');
    expect(prompt).toContain('confidence');
    expect(prompt).toContain('needs_more_context');
  });
});

describe('steering', () => {
  it('returns a validated steering from Ollama JSON', async () => {
    const fetchMock = mockFetchJson({
      message: { content: JSON.stringify(validSteering) },
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await steer('fix the blueprint loader', {
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    expect(result).toEqual(validSteering);
  });

  it('sends the configured model and requests JSON format', async () => {
    // Isolate from the real user config so keep_alive is deterministic.
    const cfgDir = mkdtempSync(join(tmpdir(), 'to-class-'));
    const cfgFile = join(cfgDir, 'config.yaml');
    writeFileSync(cfgFile, 'steering:\n  model: default-model\n  keep_alive: 30m\n', 'utf8');
    process.env.CADET_BRAINSTEM_CONFIG = cfgFile;
    try {
      const fetchMock = mockFetchJson({
        message: { content: JSON.stringify(validSteering) },
      });
      vi.stubGlobal('fetch', fetchMock);
      await steer('debug flaky test', {
        model: 'custom-model',
        host: 'http://localhost:11434',
      });
      const body = requestBodyOf(fetchMock);
      expect(body.model).toBe('custom-model');
      expect(body.format).toEqual(STEERING_JSON_SCHEMA);
      expect(body.stream).toBe(false);
      expect(body.think).toBe(false);
      expect(body.keep_alive).toBe('30m');
      expect((body.options as { temperature?: number; num_predict?: number; num_ctx?: number }).temperature).toBe(0);
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it('reads the model from config when not provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'to-class-'));
    const cfgFile = join(dir, 'config.yaml');
    writeFileSync(
      cfgFile,
      'steering:\n  model: config-model\n',
      'utf8',
    );
    process.env.CADET_BRAINSTEM_CONFIG = cfgFile;
    try {
      const fetchMock = mockFetchJson({
        message: { content: JSON.stringify(validSteering) },
      });
      vi.stubGlobal('fetch', fetchMock);
      await steer('hello', { host: 'http://localhost:11434' });
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
      'steering:\n  model: config-model\n  timeout_ms: 45000\n  keep_alive: 15m\n',
      'utf8',
    );
    process.env.CADET_BRAINSTEM_CONFIG = cfgFile;
    try {
      const fetchMock = mockFetchJson({
        message: { content: JSON.stringify(validSteering) },
      });
      vi.stubGlobal('fetch', fetchMock);
      await steer('hello', { host: 'http://localhost:11434' });
      const body = requestBodyOf(fetchMock);
      expect(body.model).toBe('config-model');
      expect(body.keep_alive).toBe('15m');
      const steering = new OllamaSteerer({
        host: 'http://localhost:11434',
      });
      expect(steering.timeoutMs).toBe(45000);
      expect(steering.keepAlive).toBe('15m');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws SteeringUnavailableError when Ollama is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      steer('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(SteeringUnavailableError);
  });

  it('throws SteeringUnavailableError on a non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetchJson({}, false, 500));
    await expect(
      steer('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(SteeringUnavailableError);
  });

  it('throws SteeringValidationError on invalid JSON output', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({ message: { content: JSON.stringify({ task: 'nope' }) } }),
    );
    await expect(
      steer('hi', { model: 'm', host: 'http://localhost:11434' }),
    ).rejects.toThrow(SteeringValidationError);
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

describe('OllamaSteerer', () => {
  it('classifies through the class API', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson({ message: { content: JSON.stringify(validSteering) } }),
    );
    const steering = new OllamaSteerer({
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    await expect(steering.steer('refactor this')).resolves.toEqual(
      validSteering,
    );
  });

  it('reports availability', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ models: [] }));
    const steering = new OllamaSteerer({
      model: 'qwen3:4b',
      host: 'http://localhost:11434',
    });
    await expect(steering.isAvailable()).resolves.toBe(true);
  });
});
