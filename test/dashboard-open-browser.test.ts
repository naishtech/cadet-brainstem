import { describe, expect, it } from 'vitest';
import { buildOpenCommand, isNonInteractive } from '../src/dashboard/open-browser';

describe('buildOpenCommand', () => {
  it('uses xdg-open on linux', () => {
    expect(buildOpenCommand('linux', 'http://x')).toBe('xdg-open "http://x"');
  });

  it('uses open on darwin', () => {
    expect(buildOpenCommand('darwin', 'http://x')).toBe('open "http://x"');
  });

  it('uses start on win32', () => {
    expect(buildOpenCommand('win32', 'http://x')).toBe('start "" "http://x"');
  });

  it('respects BROWSER', () => {
    expect(buildOpenCommand('linux', 'http://x', 'firefox')).toBe('"firefox" "http://x"');
    expect(buildOpenCommand('win32', 'http://x', 'chrome')).toBe(
      'start "" "chrome" "http://x"',
    );
  });
});

describe('isNonInteractive', () => {
  it('returns true when CADET_BRAINSTEM_CI is set', () => {
    const saved = process.env.CADET_BRAINSTEM_CI;
    process.env.CADET_BRAINSTEM_CI = '1';
    try {
      expect(isNonInteractive()).toBe(true);
    } finally {
      if (saved === undefined) {
        delete process.env.CADET_BRAINSTEM_CI;
      } else {
        process.env.CADET_BRAINSTEM_CI = saved;
      }
    }
  });
});
