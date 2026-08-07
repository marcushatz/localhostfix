# Changelog

All notable changes to LocalhostFix are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/). While the major version is
`0`, minor releases may contain breaking changes; the `report.json`
`schemaVersion` field is versioned independently and documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## [Unreleased]

### Changed — renamed to LocalhostFix (2026-08-07)

- The project was renamed from its working name "AgentView" to **LocalhostFix**
  before any public release. The npm package, CLI binary, and GitHub repository
  are all `localhostfix`, each verified available from the terminal — see
  docs/NAMING.md for the evidence and for why the previous name was abandoned.
- Generated paths moved: `.agentview/` → `.localhostfix/`, and the Claude Code
  skill from `.claude/skills/agentview/` to `.claude/skills/localhostfix/`.
  Hook entries are tagged `localhostfix-hook`.
- **Legacy handling, deliberately minimal.** Because nothing was ever published,
  there is no migration system. `doctor` and `setup` print a one-line notice
  when a pre-rename `.agentview/` directory is present, suggesting
  `mv .agentview .localhostfix`. Nothing is moved or deleted automatically and
  no command reads the old directory. `legacyDirNotice()` in
  `src/config/config.ts` is marked for removal once no development machine
  still has one.

### Added — `localhostfix fix` (2026-08-07)

- New command that attempts safe recovery of frontend inspection and then
  **verifies** whether it works again. It reuses the discovery and diagnosis
  code behind `doctor` and `inspect`; there is no parallel logic.
- Repairs automatically: a wrong stored port, a dev server that is not running,
  a dev server needing longer to become ready, a corrupt `.localhostfix/config.json`
  (backed up before regeneration), and a stale inspection lock from a crashed run.
- Requires explicit approval (`--yes`) before installing the Chromium build.
- Diagnoses without acting: application crashes, blank renders, failed APIs,
  a dev server that exits on startup, a port held by a foreign process, several
  ambiguous project servers, a missing dev command, and a non-localhost URL.
- Outcomes `ALREADY_HEALTHY` / `FIXED` / `APPLICATION_FIX_REQUIRED` /
  `COULD_NOT_REPAIR` with exit codes 0/0/1/2. `FIXED` is reported only when a
  fresh inspection after the repair actually rendered the application.
- Never modifies application source, signals a process it did not start, or
  disables a privacy guard to make a run succeed.

### Changed — pre-release hardening (2026-08-07)

- `doctor` and `inspect` now share one authoritative server-discovery module.
  `doctor` previously probed only the configured port and could therefore
  report a project as healthy because *something* answered there.
- New `MULTIPLE_PROJECT_SERVERS` verdict: when several servers run inside the
  project and none is clearly the dev server, LocalhostFix reports the ambiguity
  and asks for `--url` instead of guessing.
- A missing dev command is now an error only when no project server is
  already running.
- OS-specific work moved behind a `ProcessInspector` interface
  (`src/platform/`), with a `/proc`-based Linux implementation and an explicit
  unsupported implementation for Windows.
- CLI polish: relative artifact paths, honest `setup` guidance when a project
  cannot be inspected yet, clearer `status` wording, and graceful `watch`
  shutdown that cannot orphan a dev server.

### Fixed — pre-release hardening (2026-08-07)

- `doctor` probed a configured URL without checking it was localhost. The
  guard now lives inside discovery, the only code that makes requests.

### Security

- Adversarial redaction tests leak fake secrets through authorization headers,
  cookies, `x-api-key`, `x-csrf-token`, and query parameters, then scan every
  generated artifact. Verified non-vacuous by a negative control.

### Added — 0.1.0 (not yet released)

- `localhostfix inspect` — one-shot rendered-frontend verification producing
  desktop and mobile screenshots, console/network/page-error diagnostics, an
  accessibility snapshot, and Markdown + JSON reports.
- `localhostfix doctor` — layered health check of the project, dev server,
  browser, and agent integration, with `--fix` for safe repairs.
- `localhostfix setup` — framework, package-manager, dev-command and port
  detection; project configuration; `.gitignore` entries; optional Claude Code
  integration via `--claude`.
- `localhostfix watch`, `localhostfix status`, `localhostfix clean`.
- Layered failure model with 17 verdicts, each mapped to an inspection layer,
  a domain (`setup` / `application` / `healthy` / `unknown`), and a stable
  exit code.
- Conservative multi-signal blank-render detection reporting `true`, `false`,
  or `uncertain` with confidence and evidence.
- Dev-server discovery that finds a project's server **on any port** by
  matching listening processes' working directories, and ranks candidates by
  whether they look like the framework's dev server.
- Port-ownership verification preventing LocalhostFix from inspecting — and
  reporting on — an application other than the one under development.
- Redaction of sensitive headers and query parameters; request and response
  bodies are never stored.
- Claude Code project skill plus optional loop-safe automatic verification
  hooks, installed to `.claude/settings.local.json` by default.
- 108 tests spanning unit, integration, and hook end-to-end coverage.
- GitHub Actions CI with three tiers that do not pretend to be each other:
  code compatibility, browser integration, and OS-specific server discovery.
- `docs/PLATFORM_SUPPORT.md` (Verified/Expected/Untested/Unsupported per
  feature) and `docs/NAMING.md` (name availability research).

[Unreleased]: https://github.com/marcushatz/localhostfix/commits/main

<!-- Once v0.1.0 is tagged, change the link above to:
     https://github.com/marcushatz/localhostfix/compare/v0.1.0...HEAD -->
