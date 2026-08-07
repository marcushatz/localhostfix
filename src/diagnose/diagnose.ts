import type { RouteEvidence } from '../inspect/collect.js';
import { assessBlankness, type BlankAssessment } from './blank.js';
import type { Confidence, Evidence, Verdict } from './verdict.js';

export interface Diagnosis {
  verdict: Verdict;
  confidence: Confidence;
  evidence: Evidence[];
  blank: BlankAssessment;
  recommendation: string;
}

const LOGIN_URL_PATTERN = /\/(login|log-in|signin|sign-in|auth|sso|oauth)([/?#]|$)/i;

/** Resource types whose failure means the app's data/code didn't load. */
const CRITICAL_RESOURCE_TYPES = new Set(['document', 'script', 'fetch', 'xhr', 'stylesheet']);

/**
 * Map collected route evidence to a single primary verdict, ordered from the
 * innermost broken layer outward. Every contributing fact is listed as
 * evidence even when it is not the primary verdict.
 */
export function diagnoseRoute(ev: RouteEvidence): Diagnosis {
  const evidence: Evidence[] = [];
  const blank = assessBlankness(ev);

  // Gather all facts first.
  for (const err of ev.pageErrors.slice(0, 5)) {
    evidence.push({ kind: 'page-error', detail: err.message });
  }
  const overlays = ev.domStats?.errorOverlays.filter((o) => o.present && o.text.length > 0) ?? [];
  for (const o of overlays) {
    evidence.push({ kind: 'framework-error-overlay', detail: `${o.selector}: ${o.text.slice(0, 300)}` });
  }
  const criticalFailures = ev.network.filter(
    (n) => CRITICAL_RESOURCE_TYPES.has(n.resourceType) && (n.status === null || n.status >= 500),
  );
  for (const n of criticalFailures.slice(0, 8)) {
    evidence.push({
      kind: n.status ? `http-${n.status}` : 'request-failed',
      detail: `${n.method} ${n.url} → ${n.status ?? n.failure}`,
    });
  }
  const consoleErrors = ev.console.filter((c) => c.type === 'error');
  for (const c of consoleErrors.slice(0, 5)) {
    evidence.push({ kind: 'console-error', detail: c.text.slice(0, 300) });
  }
  for (const reason of blank.likelyBlank === true ? blank.reasons : []) {
    evidence.push({ kind: 'blank-signal', detail: reason });
  }

  // Primary verdict, innermost layer first.
  if (ev.navigationError) {
    return finalize('NAVIGATION_FAILED', 'high', [
      { kind: 'navigation-error', detail: ev.navigationError },
      ...evidence,
    ]);
  }

  if (ev.mainStatus === 404) {
    return finalize('ROUTE_NOT_FOUND', 'high', [
      { kind: 'http-404', detail: `main document returned HTTP 404 for ${ev.url}` },
      ...evidence,
    ]);
  }

  const authEvidence = detectAuthGate(ev);
  if (authEvidence) {
    return finalize('AUTHENTICATION_GATE', authEvidence.confidence, [
      ...authEvidence.evidence,
      ...evidence,
    ]);
  }

  if (ev.pageErrors.length > 0 || overlays.length > 0) {
    return finalize('APPLICATION_RUNTIME_FAILURE', 'high', evidence);
  }

  if (ev.mainStatus !== null && ev.mainStatus >= 500) {
    return finalize('APPLICATION_RUNTIME_FAILURE', 'high', [
      { kind: `http-${ev.mainStatus}`, detail: `main document returned HTTP ${ev.mainStatus}` },
      ...evidence,
    ]);
  }

  if (blank.likelyBlank === true) {
    return finalize('LIKELY_BLANK_RENDER', blank.confidence, evidence);
  }

  if (criticalFailures.length > 0) {
    return finalize('FAILED_DEPENDENCY_REQUEST', 'high', evidence);
  }

  if (ev.domStats === null && ev.desktopScreenshot === null) {
    return finalize('INDETERMINATE', 'low', [
      { kind: 'no-evidence', detail: 'navigation succeeded but no DOM stats or screenshot could be captured' },
      ...evidence,
    ]);
  }

  const minorProblems =
    consoleErrors.length > 0 ||
    ev.network.length > 0 ||
    (ev.domStats?.brokenImageCount ?? 0) > 0 ||
    blank.likelyBlank === 'uncertain';
  if (minorProblems) {
    if ((ev.domStats?.brokenImageCount ?? 0) > 0) {
      evidence.push({
        kind: 'broken-images',
        detail: `${ev.domStats?.brokenImageCount} image(s) failed to load`,
      });
    }
    for (const n of ev.network.filter((x) => !criticalFailures.includes(x)).slice(0, 5)) {
      evidence.push({
        kind: n.status ? `http-${n.status}` : 'request-failed',
        detail: `${n.method} ${n.url} → ${n.status ?? n.failure}`,
      });
    }
    if (blank.likelyBlank === 'uncertain') {
      for (const reason of blank.reasons) evidence.push({ kind: 'sparse-signal', detail: reason });
    }
    return finalize('PARTIAL_RENDER', 'medium', evidence);
  }

  return finalize('HEALTHY_RENDER', 'high', [
    {
      kind: 'render-ok',
      detail: `page rendered with ${ev.domStats?.visibleElementCount ?? '?'} visible elements and ${ev.domStats?.visibleTextLength ?? '?'} characters of text`,
    },
  ]);

  function finalize(verdict: Verdict, confidence: Confidence, list: Evidence[]): Diagnosis {
    return {
      verdict,
      confidence,
      evidence: dedupe(list),
      blank,
      recommendation: recommend(verdict, ev, list),
    };
  }
}

function detectAuthGate(
  ev: RouteEvidence,
): { confidence: Confidence; evidence: Evidence[] } | null {
  const out: Evidence[] = [];
  if (ev.mainStatus === 401 || ev.mainStatus === 403) {
    out.push({ kind: `http-${ev.mainStatus}`, detail: `main document returned HTTP ${ev.mainStatus}` });
    return { confidence: 'high', evidence: out };
  }
  const redirectedToLogin = ev.redirected && LOGIN_URL_PATTERN.test(ev.finalUrl);
  if (redirectedToLogin) {
    out.push({ kind: 'auth-redirect', detail: `redirected to ${ev.finalUrl}` });
  }
  const passwordGate =
    (ev.domStats?.hasPasswordInput ?? false) && (ev.domStats?.visibleTextLength ?? 0) < 600;
  if (passwordGate) {
    out.push({ kind: 'password-form', detail: 'page is dominated by a password form' });
  }
  if (redirectedToLogin && passwordGate) return { confidence: 'high', evidence: out };
  if (redirectedToLogin) return { confidence: 'medium', evidence: out };
  return null;
}

function recommend(verdict: Verdict, ev: RouteEvidence, evidence: Evidence[]): string {
  switch (verdict) {
    case 'NAVIGATION_FAILED':
      return 'The browser could not load the page at all. Verify the URL and that the dev server is serving this route, then re-run `localhostfix doctor`.';
    case 'ROUTE_NOT_FOUND':
      return `The route ${new URL(ev.url).pathname} does not exist on this server. Check the route path or inspect a different route.`;
    case 'AUTHENTICATION_GATE':
      return 'The route is behind authentication. Inspect a public route, or sign in manually in a headed session — LocalhostFix will not bypass auth.';
    case 'APPLICATION_RUNTIME_FAILURE': {
      const first = evidence.find((e) => e.kind === 'page-error' || e.kind === 'framework-error-overlay');
      return `Fix the application error first${first ? ` (${first.detail.slice(0, 120)})` : ''} before changing visual styling. This is an app bug, not a tooling problem.`;
    }
    case 'FAILED_DEPENDENCY_REQUEST':
      return 'The page rendered its shell but critical requests failed. Fix the failing API/resource requests listed in network.json.';
    case 'LIKELY_BLANK_RENDER':
      return 'The page very likely rendered blank. Check that the app mounts into its root element and review console/page errors.';
    case 'PARTIAL_RENDER':
      return 'The page rendered but with problems (see evidence). Review console errors and failed requests before treating the page as verified.';
    case 'HEALTHY_RENDER':
      return 'Rendering succeeded. Inspect desktop.png and mobile.png to verify the visual result — a rendered page is not automatically a correct page.';
    case 'INDETERMINATE':
      return 'LocalhostFix could not gather enough evidence to classify this page. Re-run with --headed to observe the browser directly.';
    default:
      return 'See evidence and artifacts.';
  }
}

function dedupe(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const key = e.kind + '|' + e.detail;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
