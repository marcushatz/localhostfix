import type { BlankAssessment } from '../diagnose/blank.js';
import type { Confidence, Evidence, InspectionLayer, Verdict } from '../diagnose/verdict.js';

/**
 * report.json schema, version 1. This is a stable contract for hooks and
 * agent integrations; bump schemaVersion on breaking changes and document
 * them in docs/REPORT_SCHEMA.md.
 */
export interface InspectionReport {
  schemaVersion: 1;
  tool: { name: 'localhostfix'; version: string };
  startedAt: string;
  durationMs: number;
  verdict: Verdict;
  confidence: Confidence;
  layer: InspectionLayer;
  /** Whose problem this is: LocalhostFix/environment vs the application. */
  domain: 'setup' | 'application' | 'healthy' | 'unknown';
  exitCode: number;
  route: string;
  url: string | null;
  server: {
    reachable: boolean;
    startedByLocalhostFix: boolean;
    reusedExisting: boolean;
    command: string | null;
    expectedPort: number | null;
    actualUrl: string | null;
    portMismatch: boolean;
    /**
     * Whether the process serving the URL belongs to the tree LocalhostFix
     * started ('ours'), was an intentionally reused pre-existing server
     * ('reused'), or could not be determined ('unknown').
     */
    ownership: 'ours' | 'reused' | 'unknown';
    /**
     * Reachable servers deliberately NOT used because they belong to a
     * different project. Surfaced so the developer learns why LocalhostFix
     * started its own server on a different port.
     */
    skippedForeign: { url: string; cwd: string; owners: string[] }[];
  };
  browser: {
    launched: boolean;
    executablePath: string | null;
    detail: string | null;
  };
  navigation: {
    attempted: boolean;
    status: number | null;
    error: string | null;
    finalUrl: string | null;
    redirected: boolean;
  };
  render: {
    blank: BlankAssessment | null;
    visibleElementCount: number | null;
    visibleTextLength: number | null;
    title: string | null;
  };
  counts: {
    pageErrors: number;
    consoleErrors: number;
    consoleWarnings: number;
    failedRequests: number;
  };
  evidence: Evidence[];
  recommendation: string;
  /** Relative paths within the run directory; null when not produced. */
  artifacts: {
    reportMd: string | null;
    desktopScreenshot: string | null;
    mobileScreenshot: string | null;
    console: string | null;
    network: string | null;
    pageErrors: string | null;
    serverLog: string | null;
    snapshot: string | null;
  };
  runDir: string;
}

const VERDICT_HEADLINES: Record<Verdict, string> = {
  PROJECT_NOT_RECOGNIZED: 'LocalhostFix could not recognize this project',
  DEV_COMMAND_NOT_FOUND: 'No development command found',
  SERVER_START_FAILED: 'The development server failed to start',
  SERVER_START_TIMEOUT: 'The development server did not become ready in time',
  SERVER_UNREACHABLE: 'The development server is not reachable',
  SERVER_PORT_CONFLICT: 'The advertised port is served by a process LocalhostFix did not start',
  MULTIPLE_PROJECT_SERVERS: 'Several servers are running in this project and LocalhostFix will not guess',
  PORT_MISMATCH: 'The server is running on a different port than configured',
  BROWSER_NOT_INSTALLED: 'Chromium is not installed for Playwright',
  BROWSER_LAUNCH_FAILED: 'Chromium failed to launch',
  NAVIGATION_FAILED: 'The browser could not load the page',
  ROUTE_NOT_FOUND: 'The route does not exist (HTTP 404)',
  AUTHENTICATION_GATE: 'The route is behind authentication',
  APPLICATION_RUNTIME_FAILURE: 'The application crashed at runtime',
  FAILED_DEPENDENCY_REQUEST: 'Critical requests failed while rendering',
  LIKELY_BLANK_RENDER: 'The page very likely rendered blank',
  PARTIAL_RENDER: 'The page rendered with problems',
  HEALTHY_RENDER: 'The page rendered successfully',
  INDETERMINATE: 'LocalhostFix could not determine the page state',
};

export function renderMarkdownReport(r: InspectionReport): string {
  const lines: string[] = [];
  lines.push('# LocalhostFix Frontend Inspection');
  lines.push('');
  lines.push(`Result: **${r.verdict}** (confidence: ${r.confidence})`);
  lines.push('');
  lines.push(VERDICT_HEADLINES[r.verdict] + '.');
  lines.push('');
  lines.push(`URL: ${r.url ?? '(never determined)'}`);
  lines.push('');

  lines.push('## Layers');
  lines.push('');
  lines.push(`- Server: ${serverLine(r)}`);
  for (const skipped of r.server.skippedForeign) {
    lines.push(
      `  - Skipped ${skipped.url}: it is served by ${skipped.owners.join(', ')} running in ${skipped.cwd}, which is a different project.`,
    );
  }
  lines.push(`- Browser: ${browserLine(r)}`);
  lines.push(`- Navigation: ${navigationLine(r)}`);
  lines.push(`- Render: ${renderLine(r)}`);
  lines.push('');

  if (r.evidence.length > 0) {
    lines.push('## Strongest evidence');
    lines.push('');
    for (const e of r.evidence.slice(0, 12)) {
      lines.push(`- ${e.detail}`);
    }
    lines.push('');
  }

  if (r.render.blank && r.render.blank.likelyBlank !== false) {
    lines.push('## Blank-render assessment');
    lines.push('');
    lines.push(
      `likelyBlank: ${r.render.blank.likelyBlank} (confidence: ${r.render.blank.confidence})`,
    );
    for (const reason of r.render.blank.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  const a = r.artifacts;
  const artifactList: [string, string | null][] = [
    ['Desktop screenshot', a.desktopScreenshot],
    ['Mobile screenshot', a.mobileScreenshot],
    ['Console messages', a.console],
    ['Network problems', a.network],
    ['Page errors', a.pageErrors],
    ['Server log', a.serverLog],
    ['Accessibility snapshot', a.snapshot],
    ['Machine-readable report', 'report.json'],
  ];
  for (const [label, file] of artifactList) {
    lines.push(file ? `- ${label}: ${file}` : `- ${label}: (not produced)`);
  }
  lines.push('');

  lines.push('## Recommended next action');
  lines.push('');
  lines.push(r.recommendation);
  lines.push('');
  lines.push(
    `> Domain: this is ${
      r.domain === 'setup'
        ? 'an environment/setup problem — fixing application code will not resolve it'
        : r.domain === 'application'
          ? "an application problem — LocalhostFix's tooling chain worked"
          : r.domain === 'healthy'
            ? 'a healthy inspection — verify the screenshots before claiming visual correctness'
            : 'unclassified — treat conclusions as uncertain'
    }.`,
  );
  lines.push('');
  return lines.join('\n');
}

function serverLine(r: InspectionReport): string {
  if (!r.server.reachable) return 'not reachable';
  const how = r.server.reusedExisting
    ? 'reused already-running server'
    : `started by LocalhostFix${r.server.ownership === 'ours' ? ', port ownership verified' : ''}`;
  const mismatch = r.server.portMismatch
    ? ` — note: actual URL ${r.server.actualUrl} differs from configured port ${r.server.expectedPort}`
    : '';
  return `running and reachable at ${r.server.actualUrl} (${how})${mismatch}`;
}

function browserLine(r: InspectionReport): string {
  if (r.browser.launched) return 'Chromium launched successfully';
  return r.browser.detail ?? 'not launched';
}

function navigationLine(r: InspectionReport): string {
  if (!r.navigation.attempted) return 'not attempted';
  if (r.navigation.error) return `failed: ${r.navigation.error}`;
  const redirect = r.navigation.redirected ? ` (redirected to ${r.navigation.finalUrl})` : '';
  return `main document returned HTTP ${r.navigation.status}${redirect}`;
}

function renderLine(r: InspectionReport): string {
  if (r.render.visibleElementCount === null) return 'no render evidence collected';
  return `${r.render.visibleElementCount} visible elements, ${r.render.visibleTextLength} chars of visible text, title "${r.render.title}"`;
}
