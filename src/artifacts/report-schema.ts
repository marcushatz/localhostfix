import { z } from 'zod';
import { VERDICTS, INSPECTION_LAYERS } from '../diagnose/verdict.js';

/**
 * Runtime schema for report.json. This is the published contract that hooks
 * and other agent integrations depend on, so it is validated in tests rather
 * than only described in documentation.
 */
export const EvidenceSchema = z.object({
  kind: z.string(),
  detail: z.string(),
});

export const BlankAssessmentSchema = z.object({
  likelyBlank: z.union([z.boolean(), z.literal('uncertain')]),
  confidence: z.enum(['high', 'medium', 'low']),
  reasons: z.array(z.string()),
});

export const InspectionReportSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.object({ name: z.literal('localhostfix'), version: z.string() }),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  verdict: z.enum(VERDICTS),
  confidence: z.enum(['high', 'medium', 'low']),
  layer: z.enum(INSPECTION_LAYERS),
  domain: z.enum(['setup', 'application', 'healthy', 'unknown']),
  exitCode: z.number().int().min(0).max(4),
  route: z.string(),
  url: z.string().nullable(),
  server: z.object({
    reachable: z.boolean(),
    startedByLocalhostFix: z.boolean(),
    reusedExisting: z.boolean(),
    command: z.string().nullable(),
    expectedPort: z.number().nullable(),
    actualUrl: z.string().nullable(),
    portMismatch: z.boolean(),
    ownership: z.enum(['ours', 'reused', 'unknown']),
    skippedForeign: z.array(
      z.object({ url: z.string(), cwd: z.string(), owners: z.array(z.string()) }),
    ),
  }),
  browser: z.object({
    launched: z.boolean(),
    executablePath: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  navigation: z.object({
    attempted: z.boolean(),
    status: z.number().nullable(),
    error: z.string().nullable(),
    finalUrl: z.string().nullable(),
    redirected: z.boolean(),
  }),
  render: z.object({
    blank: BlankAssessmentSchema.nullable(),
    visibleElementCount: z.number().nullable(),
    visibleTextLength: z.number().nullable(),
    title: z.string().nullable(),
  }),
  counts: z.object({
    pageErrors: z.number().int().nonnegative(),
    consoleErrors: z.number().int().nonnegative(),
    consoleWarnings: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
  }),
  evidence: z.array(EvidenceSchema),
  recommendation: z.string().min(1),
  artifacts: z.object({
    reportMd: z.string().nullable(),
    desktopScreenshot: z.string().nullable(),
    mobileScreenshot: z.string().nullable(),
    console: z.string().nullable(),
    network: z.string().nullable(),
    pageErrors: z.string().nullable(),
    serverLog: z.string().nullable(),
    snapshot: z.string().nullable(),
  }),
  runDir: z.string(),
});
