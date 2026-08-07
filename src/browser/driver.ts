import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * LocalhostFix launches with `channel: 'chromium'` — Playwright's "new headless"
 * mode, which is the real Chromium binary rather than the reduced headless
 * shell. Rendering fidelity is the entire point of this tool, so the faithful
 * binary is the right default even though it is slightly slower to start.
 *
 * Note: `chromium.executablePath()` reports where Playwright EXPECTS a binary,
 * not whether one exists, and it ignores the `channel` option. It is therefore
 * a hint for diagnostics only — never an install check on its own.
 */
export interface BrowserAvailability {
  installed: boolean;
  executablePath: string | null;
  /** Every Chromium-family build found in the Playwright cache. */
  foundBuilds: string[];
  detail: string;
}

export const INSTALL_COMMAND = 'npx playwright install chromium';

export function checkBrowserInstalled(): BrowserAvailability {
  let expected: string | null = null;
  try {
    expected = chromium.executablePath();
  } catch {
    expected = null;
  }

  const foundBuilds = listCachedChromiumBuilds();
  const expectedExists = Boolean(expected && fs.existsSync(expected));

  if (expectedExists) {
    return {
      installed: true,
      executablePath: expected,
      foundBuilds,
      detail: `Chromium at ${expected}`,
    };
  }
  return {
    installed: false,
    executablePath: expected,
    foundBuilds,
    detail:
      `Chromium expected at ${expected ?? '(unknown)'} but it is not on disk.` +
      (foundBuilds.length > 0
        ? ` Other cached builds exist (${foundBuilds.join(', ')}) but do not match this Playwright version.`
        : '') +
      ` Run: ${INSTALL_COMMAND}`,
  };
}

function playwrightCacheDir(): string | null {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') return override;
  if (override === '0') return null; // hermetic install inside node_modules
  const home = process.env.HOME ?? '';
  if (!home) return null;
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32')
    return path.join(process.env.LOCALAPPDATA ?? home, 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

function listCachedChromiumBuilds(): string[] {
  const dir = playwrightCacheDir();
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('chromium-') || name.startsWith('chromium_headless_shell-'));
  } catch {
    return [];
  }
}

export type LaunchResult =
  | { ok: true; browser: Browser }
  | { ok: false; kind: 'BROWSER_NOT_INSTALLED' | 'BROWSER_LAUNCH_FAILED'; detail: string };

const MISSING_EXECUTABLE_PATTERN = /Executable doesn't exist|please run the following command/i;

export async function launchChromium(opts: { headed?: boolean } = {}): Promise<LaunchResult> {
  try {
    const browser = await chromium.launch({
      channel: 'chromium', // new headless: the real Chromium build
      headless: !opts.headed,
    });
    return { ok: true, browser };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A launch attempt is the only authoritative install check — and its own
    // error message already names the exact remediation command.
    if (MISSING_EXECUTABLE_PATTERN.test(message)) {
      return {
        ok: false,
        kind: 'BROWSER_NOT_INSTALLED',
        detail: `${firstLines(message, 2)} — run: ${INSTALL_COMMAND}`,
      };
    }
    return { ok: false, kind: 'BROWSER_LAUNCH_FAILED', detail: firstLines(message, 3) };
  }
}

function firstLines(s: string, n: number): string {
  return s.split('\n').slice(0, n).join(' ').trim();
}
