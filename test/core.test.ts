import { describe, expect, it } from 'vitest';
import type { ContextOptimizer } from '../src/core/index';

class FakeOptimizer implements ContextOptimizer {
  readonly name = 'fake';

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('ContextOptimizer interface', () => {
  it('allows a tool to implement the shared contract', async () => {
    const tool: ContextOptimizer = new FakeOptimizer();
    expect(tool.name).toBe('fake');
    expect(await tool.isAvailable()).toBe(true);
    expect(tool.install).toBeUndefined();
    expect(tool.configure).toBeUndefined();
  });
});
