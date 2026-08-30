import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * True when running in a CI or non-interactive (no-TTY) context — used to skip
 * auto-opening the browser (design doc §9.2, `autoOpenNonInteractive`).
 */
export function isNonInteractive(): boolean {
  if (process.env.CADET_BRAINSTEM_CI === '1' || process.env.CI === '1') return true;
  if (process.stdout.isTTY === false || process.stdin.isTTY === false) return true;
  return false;
}

/**
 * Build the cross-platform command that opens `url` in the default browser
 * (respecting `BROWSER` when set). Returns `null` when nothing can run.
 */
export function buildOpenCommand(
  platform: NodeJS.Platform,
  url: string,
  browser?: string,
): string {
  if (browser !== undefined && browser.length > 0) {
    switch (platform) {
      case 'win32':
        return `start "" "${browser}" "${url}"`;
      case 'darwin':
        return `open -a "${browser}" "${url}"`;
      default:
        return `"${browser}" "${url}"`;
    }
  }
  switch (platform) {
    case 'win32':
      return `start "" "${url}"`;
    case 'darwin':
      return `open "${url}"`;
    default:
      return `xdg-open "${url}"`;
  }
}

export interface OpenBrowserOptions {
  /** Override the interactivity check (tests). */
  nonInteractive?: boolean;
  /** Override the command runner (tests). */
  run?: (command: string) => Promise<unknown>;
}

/**
 * Open `url` in the default browser. Skips (returns false) when non-interactive
 * or when opening fails. Never fatal.
 */
export async function openBrowser(
  url: string,
  opts: OpenBrowserOptions = {},
): Promise<boolean> {
  const nonInteractive = opts.nonInteractive ?? isNonInteractive();
  if (nonInteractive) return false;

  const command = buildOpenCommand(
    process.platform,
    url,
    process.env.BROWSER,
  );
  const run =
    opts.run ??
    ((cmd: string) =>
      execAsync(cmd, process.platform === 'win32' ? { shell: 'cmd.exe' } : undefined));
  try {
    await run(command);
    return true;
  } catch {
    return false;
  }
}
