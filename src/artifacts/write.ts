import fs from 'node:fs';
import path from 'node:path';
import { agentviewDir } from '../config/config.js';
import type { RouteEvidence } from '../inspect/collect.js';
import { renderMarkdownReport, type InspectionReport } from './report.js';

export function createRunDir(projectRoot: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const dir = path.join(agentviewDir(projectRoot), 'runs', stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface WrittenArtifacts {
  desktopScreenshot: string | null;
  mobileScreenshot: string | null;
  console: string | null;
  network: string | null;
  pageErrors: string | null;
  snapshot: string | null;
}

export function writeRouteArtifacts(runDir: string, ev: RouteEvidence): WrittenArtifacts {
  const out: WrittenArtifacts = {
    desktopScreenshot: null,
    mobileScreenshot: null,
    console: null,
    network: null,
    pageErrors: null,
    snapshot: null,
  };
  if (ev.desktopScreenshot) {
    fs.writeFileSync(path.join(runDir, 'desktop.png'), ev.desktopScreenshot);
    out.desktopScreenshot = 'desktop.png';
  }
  if (ev.mobileScreenshot) {
    fs.writeFileSync(path.join(runDir, 'mobile.png'), ev.mobileScreenshot);
    out.mobileScreenshot = 'mobile.png';
  }
  writeJson(runDir, 'console.json', ev.console);
  out.console = 'console.json';
  writeJson(runDir, 'network.json', ev.network);
  out.network = 'network.json';
  writeJson(runDir, 'page-errors.json', ev.pageErrors);
  out.pageErrors = 'page-errors.json';
  if (ev.ariaSnapshot) {
    fs.writeFileSync(path.join(runDir, 'snapshot.yml'), ev.ariaSnapshot);
    out.snapshot = 'snapshot.yml';
  }
  return out;
}

export function writeReport(runDir: string, report: InspectionReport): void {
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), renderMarkdownReport(report));
}

/**
 * Refresh `.agentview/latest` as a copy of the newest run so agents can
 * always read a stable path.
 */
export function updateLatest(projectRoot: string, runDir: string): string {
  const latest = path.join(agentviewDir(projectRoot), 'latest');
  fs.rmSync(latest, { recursive: true, force: true });
  fs.mkdirSync(latest, { recursive: true });
  for (const entry of fs.readdirSync(runDir)) {
    fs.copyFileSync(path.join(runDir, entry), path.join(latest, entry));
  }
  return latest;
}

function writeJson(dir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n');
}
