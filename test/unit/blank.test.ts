import { describe, expect, test } from 'vitest';
import { assessBlankness } from '../../src/diagnose/blank.js';
import type { DomStats, RouteEvidence } from '../../src/inspect/collect.js';

function domStats(overrides: Partial<DomStats> = {}): DomStats {
  return {
    title: 'Fixture',
    bodyWidth: 1440,
    bodyHeight: 900,
    visibleElementCount: 40,
    visibleTextLength: 800,
    visibleTextSample: 'lorem ipsum',
    interactiveElementCount: 5,
    appRoots: [{ selector: '#root', present: true, childCount: 12, textLength: 800 }],
    errorOverlays: [],
    loadingIndicators: 0,
    hasPasswordInput: false,
    imageCount: 2,
    brokenImageCount: 0,
    ...overrides,
  };
}

function evidence(stats: DomStats | null, overrides: Partial<RouteEvidence> = {}): RouteEvidence {
  return {
    url: 'http://localhost:3000/',
    finalUrl: 'http://localhost:3000/',
    redirected: false,
    mainStatus: 200,
    navigationError: null,
    console: [],
    pageErrors: [],
    network: [],
    domStats: stats,
    ariaSnapshot: null,
    desktopScreenshot: null,
    mobileScreenshot: null,
    screenshotAnalysis: null,
    timings: { navigationMs: 10, settleMs: 10, totalMs: 20 },
    ...overrides,
  };
}

describe('assessBlankness', () => {
  test('a rich page is confidently not blank', () => {
    const result = assessBlankness(evidence(domStats()));
    expect(result.likelyBlank).toBe(false);
    expect(result.confidence).toBe('high');
  });

  test('an empty app root with no text or elements is confidently blank', () => {
    const result = assessBlankness(
      evidence(
        domStats({
          visibleElementCount: 0,
          visibleTextLength: 0,
          interactiveElementCount: 0,
          appRoots: [{ selector: '#root', present: true, childCount: 0, textLength: 0 }],
        }),
      ),
    );
    expect(result.likelyBlank).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.reasons.join(' ')).toMatch(/no visible text/);
    expect(result.reasons.join(' ')).toMatch(/no rendered children/);
  });

  test('a uniform screenshot alone never makes a content-bearing page blank', () => {
    // Regression: a legitimately sparse page was being flagged because a
    // full-page screenshot is mostly background colour.
    const result = assessBlankness(
      evidence(domStats({ visibleElementCount: 5, visibleTextLength: 80, interactiveElementCount: 2 }), {
        screenshotAnalysis: { dominantColorShare: 1, distinctSampledColors: 1, nearlyUniform: true },
      }),
    );
    expect(result.likelyBlank).toBe(false);
  });

  test('a sparse page with no interactive elements is uncertain, not blank', () => {
    const result = assessBlankness(
      evidence(domStats({ visibleElementCount: 3, visibleTextLength: 20, interactiveElementCount: 0 })),
    );
    expect(result.likelyBlank).toBe('uncertain');
    expect(result.reasons.join(' ')).toMatch(/intentionally minimal/);
  });

  test('missing DOM stats yields uncertain rather than a guess', () => {
    const result = assessBlankness(evidence(null));
    expect(result.likelyBlank).toBe('uncertain');
    expect(result.confidence).toBe('low');
  });
});
