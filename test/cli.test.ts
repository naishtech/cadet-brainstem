import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json';
import { COMMANDS, VERSION, runCli } from '../src/cli/commands';
import { TELEMETRY_HELP, buildCommandHelp, buildHelp } from '../src/cli/help';

const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

afterEach(() => {
  log.mockClear();
  err.mockClear();
});

describe('help & version', () => {
  it('prints help with no args and exits 0', async () => {
    await expect(runCli([])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(buildHelp(COMMANDS));
  });

  it('prints help for --help and -h', async () => {
    await expect(runCli(['--help'])).resolves.toBe(0);
    await expect(runCli(['-h'])).resolves.toBe(0);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(buildHelp(COMMANDS));
  });

  it('prints the package version for --version and -v', async () => {
    expect(VERSION).toBe(pkg.version);
    await expect(runCli(['--version'])).resolves.toBe(0);
    await expect(runCli(['-v'])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(pkg.version);
  });
});

describe('command routing', () => {
  it('registers all top-level commands', () => {
    expect(COMMANDS.map((command) => command.name)).toEqual([
      'init',
      'doctor',
      'stats',
      'dashboard',
      'config',
      'telemetry',
    ]);
  });

  it('delegates each command to its own module', async () => {
    for (const name of ['init', 'doctor', 'stats', 'dashboard', 'config']) {
      await expect(runCli([name])).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`[cadet-token-saver] ${name}: not implemented yet`),
      );
      log.mockClear();
    }
  });

  it('shows command help for <command> --help', async () => {
    const init = COMMANDS.find((command) => command.name === 'init');
    expect(init).toBeDefined();
    await expect(runCli(['init', '--help'])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(buildCommandHelp(init!));
  });

  it('exits non-zero for an unknown command', async () => {
    await expect(runCli(['bogus'])).resolves.toBe(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('unknown command "bogus"'),
    );
  });
});

describe('telemetry subcommands', () => {
  it('prints telemetry help with no subcommand', async () => {
    await expect(runCli(['telemetry'])).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(TELEMETRY_HELP);
  });

  it('routes status/on/off to their handlers', async () => {
    for (const sub of ['status', 'on', 'off']) {
      await expect(runCli(['telemetry', sub])).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`telemetry ${sub}: not implemented yet`),
      );
      log.mockClear();
    }
  });

  it('exits non-zero for an unknown telemetry subcommand', async () => {
    await expect(runCli(['telemetry', 'bogus'])).resolves.toBe(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('unknown subcommand "bogus"'),
    );
  });
});
