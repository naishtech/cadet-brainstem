import { describe, expect, it } from 'vitest';
import { INIT_BANNER } from '../src/cli/banner';

describe('banner', () => {
  it('contains the product name', () => {
    expect(INIT_BANNER).toContain('CADET TOKEN $AVER');
  });

  it('uses bold + colour ANSI codes', () => {
    expect(INIT_BANNER).toContain('\u001b[1m'); // bold
    expect(INIT_BANNER).toContain('\u001b[36m'); // cyan
    expect(INIT_BANNER).toContain('\u001b[0m'); // reset
  });

  it('has a short tagline', () => {
    const lines = INIT_BANNER.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('local context optimisation');
  });
});
