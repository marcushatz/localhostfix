# Changelog

All notable changes to AgentView are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/). While the major version is
`0`, minor releases may contain breaking changes; the `report.json`
`schemaVersion` field is versioned independently and documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## [Unreleased]

### Added — 0.1.0 (not yet released)

- `agentview inspect` — one-shot rendered-frontend verification producing
  desktop and mobile screenshots, console/network/page-error diagnostics, an
  accessibility snapshot, and Markdown + JSON reports.
- `agentview doctor` — layered health check of the project, dev server,
  browser, and agent integration, with `--fix` for safe repairs.
- `agentview setup` — framework, package-manager, dev-command and port
  detection; project configuration; `.gitignore` entries; optional Claude Code
  integration via `--claude`.
- `agentview watch`, `agentview status`, `agentview clean`.
- Layered failure model with 17 verdicts, each mapped to an inspection layer,
  a domain (`setup` / `application` / `healthy` / `unknown`), and a stable
  exit code.
- Conservative multi-signal blank-render detection reporting `true`, `false`,
  or `uncertain` with confidence and evidence.
- Dev-server discovery that finds a project's server **on any port** by
  matching listening processes' working directories, and ranks candidates by
  whether they look like the framework's dev server.
- Port-ownership verification preventing AgentView from inspecting — and
  reporting on — an application other than the one under development.
- Redaction of sensitive headers and query parameters; request and response
  bodies are never stored.
- Claude Code project skill plus optional loop-safe automatic verification
  hooks, installed to `.claude/settings.local.json` by default.
- 72 tests spanning unit, integration, and hook end-to-end coverage.

[Unreleased]: https://example.invalid/compare
