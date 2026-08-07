# Changelog

All notable changes to LocalhostFix are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/). While the major version is
`0`, minor releases may contain breaking changes; the `report.json`
`schemaVersion` field is versioned independently and documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-08-07

First public release.

### Commands

- `localhostfix fix` — attempts safe recovery of frontend inspection, then
  re-inspects to verify. Reports `ALREADY_HEALTHY`, `FIXED`,
  `APPLICATION_FIX_REQUIRED`, or `COULD_NOT_REPAIR`, with exit codes 0/0/1/2.
  `FIXED` is only reported when a fresh inspection after the repair actually
  rendered the application.
- `localhostfix inspect` — one-shot rendered-frontend verification producing
  desktop and mobile screenshots, console/network/page-error diagnostics, an
  accessibility snapshot, and Markdown + JSON reports.
- `localhostfix doctor` — layered health check of the project, dev server,
  port ownership, browser, and agent integration, with `--fix` for safe repairs.
- `localhostfix setup` — framework, package-manager, dev-command and port
  detection; project configuration; `.gitignore` entries; optional Claude Code
  integration via `--claude`.
- `localhostfix watch`, `localhostfix status`, `localhostfix clean`.

### Repairs automatically

A wrong stored port, a dev server that is not running, a dev server needing
longer to become ready, a corrupt `.localhostfix/config.json` (backed up before
regeneration), and a stale inspection lock from a crashed run. Installing the
Chromium build requires explicit approval via `--yes`.

### Diagnoses without acting

Application crashes, blank renders, failed API requests, missing routes,
authentication gates, a dev server that exits during startup, a port held by a
foreign process, several ambiguous project servers, a missing dev command, and
a configured URL that is not localhost. Application source is never modified.

### Server identity

Dev-server discovery finds a project's server **on any port** by matching
listening processes' working directories, and ranks candidates by whether they
look like the framework's dev server. Port-ownership verification prevents
LocalhostFix from inspecting — and reporting on — an application other than the
one under development. Where OS process inspection is unavailable, ownership is
reported as unknown rather than guessed.

### Diagnosis model

A layered failure model with 19 verdicts, each mapped to an inspection layer, a
domain (`setup` / `application` / `healthy` / `unknown`), and a stable exit
code. Blank-render detection is multi-signal and conservative, reporting
`true`, `false`, or `uncertain` with confidence and evidence.

### Claude Code integration

A project skill at `.claude/skills/localhostfix/SKILL.md`, plus optional
loop-safe automatic verification hooks installed to
`.claude/settings.local.json` by default. Existing settings are merged, never
overwritten, and backed up first.

### Privacy and security

No telemetry and no network calls beyond the local server being inspected.
Localhost only unless explicitly overridden. Sensitive headers and query
parameters are redacted from saved network data; request and response bodies
are never stored. Run artifacts are git-ignored.

### Platform support

macOS and Linux are verified in CI, per-feature, in
[docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md). Windows cannot verify
server identity and is not supported for that; its code compatibility is tested
but that is not the same as working.

### Testing

108 tests across unit, integration, and hook end-to-end coverage. GitHub
Actions CI runs three tiers that do not stand in for each other: code
compatibility, browser integration, and OS-specific server discovery.

[Unreleased]: https://github.com/marcushatz/localhostfix/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/marcushatz/localhostfix/releases/tag/v0.1.0
