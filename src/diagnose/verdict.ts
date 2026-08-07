/**
 * The layered failure model. Every inspection or doctor run resolves to one
 * verdict, attributed to a specific layer of the inspection chain.
 */
export const VERDICTS = [
  'PROJECT_NOT_RECOGNIZED',
  'DEV_COMMAND_NOT_FOUND',
  'SERVER_START_FAILED',
  'SERVER_START_TIMEOUT',
  'SERVER_UNREACHABLE',
  'SERVER_PORT_CONFLICT',
  'MULTIPLE_PROJECT_SERVERS',
  'PORT_MISMATCH',
  'BROWSER_NOT_INSTALLED',
  'BROWSER_LAUNCH_FAILED',
  'NAVIGATION_FAILED',
  'ROUTE_NOT_FOUND',
  'AUTHENTICATION_GATE',
  'APPLICATION_RUNTIME_FAILURE',
  'FAILED_DEPENDENCY_REQUEST',
  'LIKELY_BLANK_RENDER',
  'PARTIAL_RENDER',
  'HEALTHY_RENDER',
  'INDETERMINATE',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Which layer of the chain a verdict belongs to. */
export const VERDICT_LAYER: Record<Verdict, InspectionLayer> = {
  PROJECT_NOT_RECOGNIZED: 'project',
  DEV_COMMAND_NOT_FOUND: 'project',
  SERVER_START_FAILED: 'server',
  SERVER_START_TIMEOUT: 'server',
  SERVER_UNREACHABLE: 'network',
  SERVER_PORT_CONFLICT: 'network',
  MULTIPLE_PROJECT_SERVERS: 'network',
  PORT_MISMATCH: 'network',
  BROWSER_NOT_INSTALLED: 'browser',
  BROWSER_LAUNCH_FAILED: 'browser',
  NAVIGATION_FAILED: 'navigation',
  ROUTE_NOT_FOUND: 'navigation',
  AUTHENTICATION_GATE: 'application',
  APPLICATION_RUNTIME_FAILURE: 'application',
  FAILED_DEPENDENCY_REQUEST: 'data',
  LIKELY_BLANK_RENDER: 'render',
  PARTIAL_RENDER: 'render',
  HEALTHY_RENDER: 'render',
  INDETERMINATE: 'unknown',
};

export const INSPECTION_LAYERS = [
  'project',
  'server',
  'network',
  'browser',
  'navigation',
  'application',
  'data',
  'render',
  'artifacts',
  'unknown',
] as const;

export type InspectionLayer = (typeof INSPECTION_LAYERS)[number];

/**
 * Whether a verdict indicates the failure is in AgentView's domain
 * (environment/setup) or the application's domain (the user's code).
 */
export function verdictDomain(v: Verdict): 'setup' | 'application' | 'healthy' | 'unknown' {
  switch (v) {
    case 'HEALTHY_RENDER':
      return 'healthy';
    case 'APPLICATION_RUNTIME_FAILURE':
    case 'FAILED_DEPENDENCY_REQUEST':
    case 'LIKELY_BLANK_RENDER':
    case 'PARTIAL_RENDER':
    case 'ROUTE_NOT_FOUND':
    case 'AUTHENTICATION_GATE':
      return 'application';
    case 'INDETERMINATE':
      return 'unknown';
    default:
      return 'setup';
  }
}

/**
 * Process exit codes. Stable contract for scripts and hooks.
 * 0 healthy · 1 application problem · 2 setup/environment problem ·
 * 3 indeterminate · 4 CLI usage error
 */
export function verdictExitCode(v: Verdict): number {
  switch (verdictDomain(v)) {
    case 'healthy':
      return 0;
    case 'application':
      return 1;
    case 'setup':
      return 2;
    case 'unknown':
      return 3;
  }
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Evidence {
  /** Short machine-usable id, e.g. "console-error", "http-500", "empty-root" */
  kind: string;
  /** Human-readable one-line description of the observed fact. */
  detail: string;
}
