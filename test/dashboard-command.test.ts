import { describe, expect, it } from 'vitest';
import {
  parseDashboardArgs,
  type DashboardOptions,
} from '../src/cli/commands/dashboard';

const base: DashboardOptions = {
  host: '127.0.0.1',
  port: 4100,
  autoOpen: true,
  autoOpenNonInteractive: false,
  enabled: true,
};

describe('parseDashboardArgs', () => {
  it('returns config defaults with no args', () => {
    const { options, stop, error } = parseDashboardArgs([], base);
    expect(error).toBeUndefined();
    expect(stop).toBe(false);
    expect(options).toEqual(base);
  });

  it('parses --port', () => {
    const { options, error } = parseDashboardArgs(['--port', '4000'], base);
    expect(error).toBeUndefined();
    expect(options.port).toBe(4000);
  });

  it('parses --no-open', () => {
    const { options, error } = parseDashboardArgs(['--no-open'], base);
    expect(error).toBeUndefined();
    expect(options.autoOpen).toBe(false);
  });

  it('parses --stop', () => {
    const { stop, error } = parseDashboardArgs(['--stop'], base);
    expect(error).toBeUndefined();
    expect(stop).toBe(true);
  });

  it('combines --port and --no-open', () => {
    const { options, stop } = parseDashboardArgs(['--port', '4000', '--no-open'], base);
    expect(options.port).toBe(4000);
    expect(options.autoOpen).toBe(false);
    expect(stop).toBe(false);
  });

  it('rejects an invalid --port', () => {
    const { error } = parseDashboardArgs(['--port', 'abc'], base);
    expect(error).toMatch(/Invalid port/);
  });

  it('rejects an out-of-range --port', () => {
    const { error } = parseDashboardArgs(['--port', '70000'], base);
    expect(error).toMatch(/Invalid port/);
  });

  it('rejects a missing --port value', () => {
    const { error } = parseDashboardArgs(['--port'], base);
    expect(error).toMatch(/requires a value/);
  });

  it('rejects unknown options', () => {
    const { error } = parseDashboardArgs(['--bogus'], base);
    expect(error).toMatch(/Unknown option/);
  });
});
