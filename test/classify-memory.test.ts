/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTool } from '../src/mcp';
import { MemoryStore } from '../src/memory';

describe('classifyTool memory auto-plan', () => {
  let dir: string;
  let oldCwd: string;

  beforeEach(() => {
    oldCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'cts-mem-'));
    // ensure tasks dir exists
    mkdirSync(join(dir, 'tasks'), { recursive: true });
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an auto-plan when relevant memories exist', async () => {
    const store = new MemoryStore(':memory:');
    const project = 'test-project';
    const memId = store.store({
      content: 'Loader gotcha: Windows startup path requires special handling\nMore details...',
      tags: ['gotcha'],
      project,
    });

    // Minimal stub classifier outcome — classifyTool only needs to call this.
    const stubClassify = async (taskText: string) => {
      return {
        classification: {
          task: 'debug',
          complexity: 'low',
          risk: 'low',
          context_need: 'targeted',
          precision: 'normal',
          tool_plan: { use: [] },
          response_policy: ['compact'],
        },
        degraded: false,
      } as any;
    };

    const result = (await classifyTool(
      { task: 'loader' },
      { classify: stubClassify as any, memory: store, defaultProject: project },
    )) as any;

    // Ensure relevant memories are returned in the response
    expect(result.relevant_memories).toBeDefined();
    expect(Array.isArray(result.relevant_memories)).toBe(true);
    const ids = result.relevant_memories.map((m: any) => m.id);
    expect(ids).toContain(memId);

    store.close();
  });
});
