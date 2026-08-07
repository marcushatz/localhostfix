import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../config/config.js';
import type { AgentViewConfig } from '../config/schema.js';
import { findProjectRoot, detectPackageManager, runScriptCommand } from '../project/discover.js';
import { adapterById, detectDevScript, detectFramework, type FrameworkAdapter } from '../frameworks/adapter.js';
import { ensureServer, writeServerLog, type ServerHandle } from '../server/lifecycle.js';
import { describeCandidate } from '../server/discovery.js';
import { isLocalUrl } from '../server/probe.js';
import { checkBrowserInstalled, launchChromium } from '../browser/driver.js';
import { collectRoute } from './collect.js';
import { diagnoseRoute } from '../diagnose/diagnose.js';
import { verdictDomain, verdictExitCode, VERDICT_LAYER, type Verdict, type Confidence, type Evidence } from '../diagnose/verdict.js';
import { createRunDir, updateLatest, writeReport, writeRouteArtifacts } from '../artifacts/write.js';
import type { InspectionReport } from '../artifacts/report.js';

const require = createRequire(import.meta.url);

export function toolVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export interface InspectOptions {
  cwd: string;
  route?: string | undefined;
  urlOverride?: string | undefined;
  headed?: boolean | undefined;
  allowRemote?: boolean | undefined;
  allowForeignServer?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
}

export interface InspectOutcome {
  report: InspectionReport;
  runDir: string;
}

/**
 * Full inspection pipeline. Always writes a report — including for failures
 * in the earliest layers — so agents always have something to read.
 */
export async function runInspection(opts: InspectOptions): Promise<InspectOutcome> {
  const startedAt = new Date();
  const progress = opts.onProgress ?? (() => {});

  const project = findProjectRoot(opts.cwd);
  const { config } = loadConfig(project.root);
  const runDir = createRunDir(project.root, startedAt);

  const builder = new ReportBuilder(startedAt, runDir, project.root);
  const route = normalizeRoute(opts.route ?? config.defaultRoute);
  builder.route = route;

  // Layer 0: project recognition + dev command.
  const adapter = adapterById(config.framework) ?? detectFramework(project.packageJson, project.root);
  const explicitUrl = opts.urlOverride ?? config.url;
  let devCommand = config.devCommand ?? null;
  if (!devCommand && project.packageJson) {
    const pm = detectPackageManager(project.root, project.packageJson);
    const script = detectDevScript(project.packageJson, adapter);
    if (script) devCommand = runScriptCommand(pm, script.script);
  }
  builder.server.command = devCommand;
  builder.server.expectedPort = config.expectedPort ?? adapter.defaultPort ?? null;

  if (!project.packageJson && !explicitUrl && !devCommand) {
    return builder.finish('PROJECT_NOT_RECOGNIZED', 'high', [
      {
        kind: 'no-project',
        detail: `no package.json, dev command, or URL override found starting from ${opts.cwd}`,
      },
    ], 'Run `agentview setup` inside a Node.js project, or set "url"/"devCommand" in .agentview/config.json.');
  }
  // Privacy guard: refuse non-local URLs unless explicitly allowed.
  if (explicitUrl && !isLocalUrl(explicitUrl) && !(opts.allowRemote ?? config.allowRemote)) {
    return builder.finish('PROJECT_NOT_RECOGNIZED', 'high', [
      { kind: 'remote-url-blocked', detail: `${explicitUrl} is not a localhost URL` },
    ], 'AgentView inspects localhost only by default. Pass --allow-remote (and understand the privacy implications) to override.');
  }

  // Layer 1-2: server + reachability.
  progress(devCommand ? `Ensuring dev server (${devCommand})…` : `Probing ${explicitUrl}…`);
  let server: ServerHandle | null = null;
  try {
    const result = await ensureServer({
      command: devCommand ?? '',
      cwd: path.join(project.root, config.cwd ?? '.'),
      projectRoot: project.root,
      allowForeignServer: opts.allowForeignServer ?? false,
      adapter,
      expectedPort: config.expectedPort ?? adapter.defaultPort ?? undefined,
      explicitUrl,
      startupTimeoutMs: config.startupTimeoutMs,
    });
    if (!result.ok) {
      if (result.kind === 'DEV_COMMAND_NOT_FOUND') {
        return builder.finish('DEV_COMMAND_NOT_FOUND', 'high', [
          {
            kind: 'no-dev-script',
            detail: `no server is running for this project, and package.json has no ${adapter.devScriptCandidates.map((s) => `"${s}"`).join('/')} script`,
          },
        ], 'Start your dev server, add a dev script to package.json, or set "devCommand" in .agentview/config.json.');
      }
      if (result.kind === 'MULTIPLE_PROJECT_SERVERS') {
        const d = result.discovery;
        return builder.finish('MULTIPLE_PROJECT_SERVERS', 'high', [
          {
            kind: 'ambiguous-servers',
            detail: `${d.projectServers.length} servers are listening inside this project and none is clearly the dev server.`,
          },
          ...d.projectServers.map((c) => ({
            kind: 'candidate',
            detail: describeCandidate(c),
          })),
          ...(d.preferred
            ? [{ kind: 'preferred', detail: `Best guess: port ${d.preferred.port}` }]
            : []),
        ], `AgentView will not guess which server is your app. Re-run with --url http://localhost:<port>, or stop the servers you are not using.`);
      }
      fs.writeFileSync(path.join(runDir, 'server.log'), result.log);
      builder.artifacts.serverLog = 'server.log';
      if (result.kind === 'SERVER_START_FAILED') {
        const tail = result.log.split('\n').filter(Boolean).slice(-8);
        return builder.finish('SERVER_START_FAILED', 'high', [
          {
            kind: 'server-exit',
            detail: `dev server exited${result.exitCode !== null ? ` with code ${result.exitCode}` : ''} before becoming reachable`,
          },
          ...tail.map((line) => ({ kind: 'server-log', detail: line.slice(0, 300) })),
        ], 'Read server.log for the startup error. Fix the dev command or its environment, then re-run.');
      }
      if (result.kind === 'SERVER_PORT_CONFLICT') {
        return builder.finish('SERVER_PORT_CONFLICT', 'high', [
          {
            kind: 'foreign-port-owner',
            detail: `${result.url} is reachable but is served by a process AgentView did not start: ${result.owners.map((o) => `${o.command} (pid ${o.pid})`).join(', ')}`,
          },
          {
            kind: 'wrong-app-risk',
            detail: 'Inspecting it would have verified a different application than the one being developed.',
          },
        ], `Stop whatever is already using that port, or point AgentView at the right one via "url"/"expectedPort" in .agentview/config.json. AgentView will not terminate a process it did not start.`);
      }
      return builder.finish('SERVER_START_TIMEOUT', 'high', [
        {
          kind: 'timeout',
          detail: `no probed URL became reachable within ${config.startupTimeoutMs}ms (tried: ${result.probedUrls.join(', ') || 'none discovered'})`,
        },
      ], 'The server may be slow or printing an unrecognized URL. Increase startupTimeoutMs or set "url" explicitly in .agentview/config.json.');
    }
    server = result.handle;
    builder.server.reachable = true;
    builder.server.reusedExisting = !server.startedByUs;
    builder.server.startedByAgentView = server.startedByUs;
    builder.server.actualUrl = server.url;
    builder.server.ownership = server.ownership;
    builder.server.skippedForeign = server.skippedForeign.map((f) => ({
      url: f.url,
      cwd: f.cwd,
      owners: f.owners.map((o) => `${o.command} (pid ${o.pid})`),
    }));
    const expected = builder.server.expectedPort;
    const actualPort = Number(new URL(server.url).port || (server.url.startsWith('https') ? 443 : 80));
    builder.server.portMismatch = expected !== null && actualPort !== expected;
    progress(`Server reachable at ${server.url}${builder.server.portMismatch ? ` (expected port ${expected})` : ''}`);

    // Layer 3: browser.
    const availability = checkBrowserInstalled();
    builder.browser.executablePath = availability.executablePath;
    if (!availability.installed) {
      return builder.finish('BROWSER_NOT_INSTALLED', 'high', [
        { kind: 'chromium-missing', detail: availability.detail },
      ], 'Install the supported Chromium build: npx playwright install chromium');
    }
    progress('Launching Chromium…');
    const launch = await launchChromium({ headed: opts.headed ?? false });
    if (!launch.ok) {
      return builder.finish(launch.kind, 'high', [
        { kind: 'browser-launch', detail: launch.detail },
      ], launch.kind === 'BROWSER_NOT_INSTALLED'
        ? 'Install the supported Chromium build: npx playwright install chromium'
        : 'Chromium failed to launch. Re-run `agentview doctor` and check the error detail.');
    }
    builder.browser.launched = true;

    // Layer 4+: navigate, collect, diagnose.
    const targetUrl = joinUrl(server.url, route);
    builder.url = targetUrl;
    progress(`Inspecting ${targetUrl}…`);
    try {
      const evidence = await collectRoute(launch.browser, {
        url: targetUrl,
        adapter,
        pageTimeoutMs: config.pageTimeoutMs,
        desktopViewport: config.desktopViewport,
        mobileViewport: config.mobileViewport,
        redact: config.redact,
      });
      const artifacts = writeRouteArtifacts(runDir, evidence);
      Object.assign(builder.artifacts, artifacts);
      builder.navigation = {
        attempted: true,
        status: evidence.mainStatus,
        error: evidence.navigationError,
        finalUrl: evidence.finalUrl,
        redirected: evidence.redirected,
      };
      builder.counts = {
        pageErrors: evidence.pageErrors.length,
        consoleErrors: evidence.console.filter((c) => c.type === 'error').length,
        consoleWarnings: evidence.console.filter((c) => c.type === 'warning').length,
        failedRequests: evidence.network.length,
      };
      builder.render = {
        blank: null,
        visibleElementCount: evidence.domStats?.visibleElementCount ?? null,
        visibleTextLength: evidence.domStats?.visibleTextLength ?? null,
        title: evidence.domStats?.title ?? null,
      };
      const diagnosis = diagnoseRoute(evidence);
      builder.render.blank = diagnosis.blank;
      return builder.finish(diagnosis.verdict, diagnosis.confidence, diagnosis.evidence, diagnosis.recommendation);
    } finally {
      await launch.browser.close().catch(() => {});
    }
  } finally {
    if (server) {
      writeServerLog(runDir, server);
      builder.artifacts.serverLog = 'server.log';
      await server.stop();
    }
  }
}

class ReportBuilder {
  route = '/';
  url: string | null = null;
  server: InspectionReport['server'] = {
    reachable: false,
    startedByAgentView: false,
    reusedExisting: false,
    command: null,
    expectedPort: null,
    actualUrl: null,
    portMismatch: false,
    ownership: 'unknown',
    skippedForeign: [],
  };
  browser: InspectionReport['browser'] = { launched: false, executablePath: null, detail: null };
  navigation: InspectionReport['navigation'] = {
    attempted: false,
    status: null,
    error: null,
    finalUrl: null,
    redirected: false,
  };
  render: InspectionReport['render'] = {
    blank: null,
    visibleElementCount: null,
    visibleTextLength: null,
    title: null,
  };
  counts: InspectionReport['counts'] = {
    pageErrors: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    failedRequests: 0,
  };
  artifacts: InspectionReport['artifacts'] = {
    reportMd: 'report.md',
    desktopScreenshot: null,
    mobileScreenshot: null,
    console: null,
    network: null,
    pageErrors: null,
    serverLog: null,
    snapshot: null,
  };

  constructor(
    private startedAt: Date,
    private runDir: string,
    private projectRoot: string,
  ) {}

  finish(
    verdict: Verdict,
    confidence: Confidence,
    evidence: Evidence[],
    recommendation: string,
  ): InspectOutcome {
    const report: InspectionReport = {
      schemaVersion: 1,
      tool: { name: 'agentview', version: toolVersion() },
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      verdict,
      confidence,
      layer: VERDICT_LAYER[verdict],
      domain: verdictDomain(verdict),
      exitCode: verdictExitCode(verdict),
      route: this.route,
      url: this.url,
      server: this.server,
      browser: this.browser,
      navigation: this.navigation,
      render: this.render,
      counts: this.counts,
      evidence,
      recommendation,
      artifacts: this.artifacts,
      runDir: path.relative(this.projectRoot, this.runDir),
    };
    writeReport(this.runDir, report);
    updateLatest(this.projectRoot, this.runDir);
    return { report, runDir: this.runDir };
  }
}

function normalizeRoute(route: string): string {
  if (!route.startsWith('/')) return '/' + route;
  return route;
}

function joinUrl(origin: string, route: string): string {
  return origin.replace(/\/$/, '') + route;
}
