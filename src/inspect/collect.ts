import { devices, type Browser, type Page } from 'playwright-core';
import { redactHeaders, redactUrl } from '../security/redact.js';
import type { FrameworkAdapter } from '../frameworks/adapter.js';

/**
 * Deterministic screenshot options: freeze animations, hide the caret, and
 * use CSS pixels so repeat runs of an unchanged page produce comparable images.
 */
const SCREENSHOT_OPTIONS = {
  fullPage: true,
  animations: 'disabled',
  caret: 'hide',
  scale: 'css',
} as const;

/**
 * Mobile emulation uses a real Chromium device profile (Pixel 7) rather than
 * only shrinking the viewport, so `pointer: coarse` / `hover: none` media
 * queries and touch behaviour match an actual phone. iPhone profiles are
 * deliberately avoided here: they declare `defaultBrowserType: 'webkit'` and
 * would not be faithful iOS emulation under Chromium.
 */
const MOBILE_DEVICE = 'Pixel 7';

export interface ConsoleEntry {
  type: string;
  text: string;
  location: string | null;
}

export interface PageErrorEntry {
  message: string;
  stack: string | null;
}

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  ok: boolean;
  failure: string | null;
  requestHeaders: Record<string, string>;
}

export interface DomStats {
  title: string;
  bodyWidth: number;
  bodyHeight: number;
  visibleElementCount: number;
  visibleTextLength: number;
  visibleTextSample: string;
  interactiveElementCount: number;
  appRoots: { selector: string; present: boolean; childCount: number; textLength: number }[];
  errorOverlays: { selector: string; present: boolean; text: string }[];
  loadingIndicators: number;
  hasPasswordInput: boolean;
  imageCount: number;
  brokenImageCount: number;
}

export interface ScreenshotAnalysis {
  /** 0..1 — fraction of sampled pixels equal to the modal color. */
  dominantColorShare: number;
  distinctSampledColors: number;
  nearlyUniform: boolean;
}

export interface RouteEvidence {
  url: string;
  finalUrl: string;
  redirected: boolean;
  mainStatus: number | null;
  navigationError: string | null;
  console: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  network: NetworkEntry[];
  domStats: DomStats | null;
  ariaSnapshot: string | null;
  desktopScreenshot: Buffer | null;
  mobileScreenshot: Buffer | null;
  screenshotAnalysis: ScreenshotAnalysis | null;
  timings: { navigationMs: number; settleMs: number; totalMs: number };
}

export interface CollectOptions {
  url: string;
  adapter: FrameworkAdapter;
  pageTimeoutMs: number;
  desktopViewport: { width: number; height: number };
  mobileViewport: { width: number; height: number };
  redact: boolean;
}

const NOISE_CONSOLE_PATTERNS = [
  /\[HMR\]/i,
  /\[vite\] (connecting|connected)/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  // Chromium mirrors every failed HTTP response onto the console channel.
  // network.json already records these with method, status, and resource
  // type, so keeping both would double-count one underlying problem.
  /^Failed to load resource: the server responded with a status of/i,
];

export async function collectRoute(browser: Browser, opts: CollectOptions): Promise<RouteEvidence> {
  const startedAt = Date.now();
  const context = await browser.newContext({
    viewport: opts.desktopViewport,
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(opts.pageTimeoutMs);
  const page = await context.newPage();

  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: PageErrorEntry[] = [];
  const network: NetworkEntry[] = [];
  let lastRequestAt = Date.now();

  page.on('console', (msg) => {
    const text = msg.text();
    if (NOISE_CONSOLE_PATTERNS.some((p) => p.test(text))) return;
    if (!['error', 'warning'].includes(msg.type())) return;
    const loc = msg.location();
    consoleEntries.push({
      type: msg.type(),
      text: text.slice(0, 2000),
      location: loc.url ? `${loc.url}:${loc.lineNumber}` : null,
    });
  });
  page.on('pageerror', (err) => {
    pageErrors.push({ message: err.message.slice(0, 2000), stack: err.stack?.slice(0, 4000) ?? null });
  });
  page.on('request', () => {
    lastRequestAt = Date.now();
  });
  page.on('requestfailed', (req) => {
    network.push({
      url: maybeRedactUrl(req.url(), opts.redact),
      method: req.method(),
      resourceType: req.resourceType(),
      status: null,
      ok: false,
      failure: req.failure()?.errorText ?? 'failed',
      requestHeaders: maybeRedactHeaders(req.headers(), opts.redact),
    });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status < 400) return; // keep artifacts small: only record problems
    const req = res.request();
    network.push({
      url: maybeRedactUrl(res.url(), opts.redact),
      method: req.method(),
      resourceType: req.resourceType(),
      status,
      ok: false,
      failure: null,
      requestHeaders: maybeRedactHeaders(req.headers(), opts.redact),
    });
  });

  let mainStatus: number | null = null;
  let navigationError: string | null = null;
  let finalUrl = opts.url;
  const navStart = Date.now();
  try {
    const response = await page.goto(opts.url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.pageTimeoutMs,
    });
    mainStatus = response?.status() ?? null;
  } catch (err) {
    navigationError = err instanceof Error ? err.message.split('\n')[0] ?? 'navigation failed' : String(err);
  }
  const navigationMs = Date.now() - navStart;

  let evidence: RouteEvidence = {
    url: opts.url,
    finalUrl,
    redirected: false,
    mainStatus,
    navigationError,
    console: consoleEntries,
    pageErrors,
    network,
    domStats: null,
    ariaSnapshot: null,
    desktopScreenshot: null,
    mobileScreenshot: null,
    screenshotAnalysis: null,
    timings: { navigationMs, settleMs: 0, totalMs: 0 },
  };

  if (navigationError === null) {
    const settleStart = Date.now();
    await settle(page, opts.pageTimeoutMs, () => lastRequestAt);
    evidence.timings.settleMs = Date.now() - settleStart;

    finalUrl = page.url();
    evidence.finalUrl = finalUrl;
    evidence.redirected = normalize(finalUrl) !== normalize(opts.url);

    evidence.domStats = await collectDomStats(page, opts.adapter).catch(() => null);
    // mode:'ai' filters noise and includes iframes — the right shape for an
    // agent reading the snapshot, and it does not wait for matching elements.
    evidence.ariaSnapshot = await page
      .ariaSnapshot({ mode: 'ai' })
      .then((s) => (s.length > 20_000 ? s.slice(0, 20_000) + '\n# [truncated]' : s))
      .catch(() => null);

    evidence.desktopScreenshot = await page
      .screenshot({ ...SCREENSHOT_OPTIONS, timeout: opts.pageTimeoutMs })
      .catch(() => null);

    if (evidence.desktopScreenshot) {
      evidence.screenshotAnalysis = await analyzeScreenshot(
        browser,
        evidence.desktopScreenshot,
        opts.desktopViewport.height,
      ).catch(() => null);
    }

    evidence.mobileScreenshot = await captureMobile(browser, opts).catch(() => null);
  }

  evidence.timings.totalMs = Date.now() - startedAt;
  await context.close().catch(() => {});
  return evidence;
}

/**
 * Capture the mobile view in its own device-emulated context. A second
 * navigation costs time but produces a screenshot that reflects real mobile
 * media queries instead of a narrow desktop window.
 */
async function captureMobile(browser: Browser, opts: CollectOptions): Promise<Buffer | null> {
  const profile = devices[MOBILE_DEVICE];
  const context = await browser.newContext({
    ...(profile ?? {}),
    // Honour a user-configured mobile viewport while keeping device traits.
    viewport: opts.mobileViewport,
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs });
    let lastRequestAt = Date.now();
    page.on('request', () => {
      lastRequestAt = Date.now();
    });
    await settle(page, opts.pageTimeoutMs, () => lastRequestAt);
    return await page.screenshot({ ...SCREENSHOT_OPTIONS, timeout: opts.pageTimeoutMs });
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Render-settle without relying on `networkidle`, which the Playwright docs
 * explicitly discourage: wait for the load event (bounded), then until no new
 * request started for 600ms, then two animation frames.
 */
async function settle(page: Page, budgetMs: number, lastRequestAt: () => number): Promise<void> {
  const cap = Math.min(budgetMs, 8000);
  const deadline = Date.now() + cap;
  await page.waitForLoadState('load', { timeout: cap }).catch(() => {});
  while (Date.now() < deadline) {
    if (Date.now() - lastRequestAt() >= 600) break;
    await page.waitForTimeout(150);
  }
  // Two animation frames so painted state matches the DOM we sample.
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    .catch(() => {});
}

async function collectDomStats(page: Page, adapter: FrameworkAdapter): Promise<DomStats> {
  return page.evaluate(
    ({ appRootSelectors, errorOverlaySelectors }) => {
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const all = [...document.querySelectorAll('body *')];
      const visible = all.filter(isVisible);
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const interactive = visible.filter((el) =>
        ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName),
      );
      const spinners = visible.filter((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        return /\b(spinner|loading|skeleton|shimmer)\b/i.test(cls + ' ' + (el.getAttribute('aria-busy') ?? ''));
      });
      const images = [...document.querySelectorAll('img')];
      const body = document.body;
      return {
        title: document.title,
        bodyWidth: body?.scrollWidth ?? 0,
        bodyHeight: body?.scrollHeight ?? 0,
        visibleElementCount: visible.length,
        visibleTextLength: text.length,
        visibleTextSample: text.slice(0, 400),
        interactiveElementCount: interactive.length,
        appRoots: appRootSelectors.map((selector: string) => {
          const el = document.querySelector(selector);
          return {
            selector,
            present: Boolean(el),
            childCount: el?.childElementCount ?? 0,
            textLength: (el?.textContent ?? '').trim().length,
          };
        }),
        errorOverlays: errorOverlaySelectors.map((selector: string) => {
          const el = document.querySelector(selector);
          return {
            selector,
            present: Boolean(el),
            text: (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
          };
        }),
        loadingIndicators: spinners.length,
        hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
        imageCount: images.length,
        brokenImageCount: images.filter((img) => img.complete && img.naturalWidth === 0 && img.src)
          .length,
      };
    },
    {
      appRootSelectors: adapter.appRootSelectors,
      errorOverlaySelectors: adapter.errorOverlaySelectors,
    },
  );
}

/**
 * Pixel-sample the screenshot inside the browser itself (canvas), avoiding
 * an image-decoding dependency. Samples a 40x40 grid with colors quantized
 * to 32-level buckets per channel.
 */
async function analyzeScreenshot(
  browser: Browser,
  png: Buffer,
  viewportHeight: number,
): Promise<ScreenshotAnalysis> {
  const context = await browser.newContext({ viewport: { width: 100, height: 100 } });
  try {
    const page = await context.newPage();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const result = await page.evaluate(async ({ src, bandHeight }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = src;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      // Sample only the first screenful. On a long page the area below the
      // fold is mostly background and would drown out real content above it.
      const sampleHeight = Math.min(canvas.height, Math.max(bandHeight, 200));
      const grid = 40;
      const counts = new Map<string, number>();
      for (let gy = 0; gy < grid; gy++) {
        for (let gx = 0; gx < grid; gx++) {
          const x = Math.floor(((gx + 0.5) / grid) * canvas.width);
          const y = Math.floor(((gy + 0.5) / grid) * sampleHeight);
          const d = ctx.getImageData(x, y, 1, 1).data;
          const key = `${d[0]! >> 3},${d[1]! >> 3},${d[2]! >> 3}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const total = grid * grid;
      const max = Math.max(...counts.values());
      return { dominantColorShare: max / total, distinctSampledColors: counts.size };
    }, { src: dataUrl, bandHeight: viewportHeight });
    return { ...result, nearlyUniform: result.dominantColorShare > 0.98 || result.distinctSampledColors <= 3 };
  } finally {
    await context.close().catch(() => {});
  }
}

function maybeRedactHeaders(headers: Record<string, string>, redact: boolean) {
  return redact ? redactHeaders(headers) : headers;
}
function maybeRedactUrl(url: string, redact: boolean) {
  return redact ? redactUrl(url) : url;
}
function normalize(u: string): string {
  return u.replace(/\/$/, '');
}
