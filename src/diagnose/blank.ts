import type { RouteEvidence } from '../inspect/collect.js';
import type { Confidence } from './verdict.js';

export interface BlankAssessment {
  likelyBlank: boolean | 'uncertain';
  confidence: Confidence;
  reasons: string[];
}

/**
 * Conservative multi-signal blank-render assessment. Strong signals must
 * agree before we call a page blank with high confidence; a sparse page
 * that might be intentional stays "uncertain".
 */
export function assessBlankness(ev: RouteEvidence): BlankAssessment {
  const reasons: string[] = [];
  const d = ev.domStats;
  if (!d) {
    return {
      likelyBlank: 'uncertain',
      confidence: 'low',
      reasons: ['DOM statistics could not be collected'],
    };
  }

  let strong = 0;
  let weak = 0;

  // Fast path: a page with real text, real elements, and something to
  // interact with is not blank, whatever the pixels look like.
  if (d.visibleTextLength >= 40 && d.visibleElementCount >= 5 && d.interactiveElementCount > 0) {
    return { likelyBlank: false, confidence: 'high', reasons: [] };
  }

  if (d.visibleTextLength === 0) {
    strong++;
    reasons.push('body contained no visible text');
  } else if (d.visibleTextLength < 40) {
    weak++;
    reasons.push(`body contained only ${d.visibleTextLength} characters of visible text`);
  }

  if (d.visibleElementCount === 0) {
    strong++;
    reasons.push('no visible elements in the body');
  } else if (d.visibleElementCount < 5) {
    weak++;
    reasons.push(`only ${d.visibleElementCount} visible elements`);
  }

  if (d.interactiveElementCount === 0 && d.visibleTextLength < 200) {
    weak++;
    reasons.push('no visible interactive elements');
  }

  const presentRoots = d.appRoots.filter((r) => r.present);
  const emptyRoots = presentRoots.filter((r) => r.childCount === 0 && r.textLength === 0);
  if (presentRoots.length > 0 && emptyRoots.length === presentRoots.length) {
    strong++;
    reasons.push(
      `application root (${emptyRoots.map((r) => r.selector).join(', ')}) exists but has no rendered children`,
    );
  }

  if (ev.screenshotAnalysis?.nearlyUniform) {
    // A uniform screenshot is only strong evidence when the DOM is also
    // empty. Plenty of healthy pages are mostly background colour, so on its
    // own this must never be enough to call a page blank.
    const domAlsoEmpty = d.visibleTextLength < 40;
    if (domAlsoEmpty) strong++;
    else weak++;
    reasons.push(
      `screenshot was nearly uniform (${Math.round(ev.screenshotAnalysis.dominantColorShare * 100)}% one colour)`,
    );
  }

  if (d.loadingIndicators > 0 && d.visibleTextLength < 100) {
    weak++;
    reasons.push(`${d.loadingIndicators} loading indicator(s) still visible after settle`);
  }

  if (ev.pageErrors.length > 0) {
    weak++;
    reasons.push('page-level JavaScript errors occurred (may explain missing content)');
  }

  if (strong >= 2) {
    return { likelyBlank: true, confidence: strong >= 3 ? 'high' : 'medium', reasons };
  }
  if (strong === 1 && weak >= 2) {
    return { likelyBlank: true, confidence: 'medium', reasons };
  }
  if (strong === 1 || weak >= 2) {
    reasons.push('an intentionally minimal page may resemble a blank page');
    return { likelyBlank: 'uncertain', confidence: 'low', reasons };
  }
  return { likelyBlank: false, confidence: 'high', reasons: [] };
}
