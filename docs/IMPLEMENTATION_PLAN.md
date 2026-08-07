# AgentView — Implementation Plan (v0.1)

Phases are executed in order, each ending in a commit with a working tree that builds and passes tests.

## Phase 0 — Research, decisions, scaffolding ✅

- Environment inspection (Node 25.2.1, npm 11.6.2, Playwright browser cache present).
- Official-source research on Playwright 1.62.1 and Claude Code skills/hooks/settings/MCP, including live API probes.
- Foundation comparison and decision → `ARCHITECTURE.md`.
- `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, this plan.
- TypeScript + vitest + commander + zod scaffolding; git repository.

## Phase 1 — Deterministic inspection core ✅

Project discovery → framework adapters → dev-server lifecycle with URL/port discovery → port-ownership verification → Chromium launch → navigation → evidence collection → artifact writing → report generation. `agentview inspect` end to end.

## Phase 2 — Doctor and diagnosis engine ✅

Layered health checks with ok/warn/fail/unknown/action levels, the full verdict model, conservative blank detection, actionable recommendations, stable exit codes, `--fix` for safe fixes.

## Phase 3 — Setup and agent integration ✅

`agentview setup` (detection, config merge, .gitignore, browser readiness), Claude project Skill, optional hook-based automatic verification with three loop-prevention mechanisms, settings preservation with backup, `agentview watch`, plus `status` and `clean`.

## Phase 4 — Testing and fixtures

Deterministic fixture apps under `test/fixtures/`, each a tiny self-contained server or Vite/Next project, exercising:

| # | Scenario | Expected verdict |
|---|---|---|
| 1 | Healthy Vite app | HEALTHY_RENDER |
| 2 | Healthy Next.js app | HEALTHY_RENDER |
| 3 | Missing dev script | DEV_COMMAND_NOT_FOUND |
| 4 | Server exits on start | SERVER_START_FAILED |
| 5 | Server never becomes ready | SERVER_START_TIMEOUT |
| 6 | Wrong expected port, discoverable actual port | HEALTHY_RENDER + portMismatch |
| 7 | Advertised port owned by another process | SERVER_PORT_CONFLICT |
| 8 | Healthy server, intentionally blank page | LIKELY_BLANK_RENDER |
| 9 | Runtime JavaScript crash | APPLICATION_RUNTIME_FAILURE |
| 10 | Critical API returns 500 | FAILED_DEPENDENCY_REQUEST |
| 11 | Route returns 404 | ROUTE_NOT_FOUND |
| 12 | Route requires authentication | AUTHENTICATION_GATE |
| 13 | Browser executable unavailable (simulated) | BROWSER_NOT_INSTALLED |
| 14 | Desktop + mobile screenshots produced | artifacts exist, non-trivial size |
| 15 | Secret/header redaction | no secrets in network.json |
| 16 | Existing Claude settings preserved | user keys and hooks intact |
| 17 | Backend-only edit does not mark stale | hook writes no marker |
| 18 | Frontend edit marks stale exactly once | one inspection at Stop |
| 19 | Hook loop prevention | no block when stop_hook_active |
| 20 | Process cleanup | no orphaned dev servers |
| 21 | report.json schema validation | matches documented schema |

Unit tests cover redaction, blank assessment, verdict mapping, URL extraction, framework detection, and config merging without launching a browser. Integration/e2e tests launch real servers and Chromium in temp directories. No test depends on an external website.

## Phase 5 — Dogfood and documentation

Run against a real local frontend, record `DOGFOOD_REPORT.md` with real artifact paths and real failures, fix weaknesses exposed, finish README/SECURITY/PRIVACY/CONTRIBUTING/LICENSE/CHANGELOG, prepare (but do not perform) release.

## Acceptance criteria → where each is satisfied

| # | Criterion | Where |
|---|---|---|
| 1 | One-command setup | `agentview setup` |
| 2 | Doctor detects framework, pm, dev command, URL, server, browser | `commands/doctor.ts` |
| 3 | Starts or reuses the dev server | `server/lifecycle.ts` |
| 4 | Detects actual URL when it differs from expected port | `extractUrlFromLog` + portMismatch |
| 5 | Launches Chromium when ready | `browser/driver.ts` |
| 6 | Desktop + mobile screenshots | `collect.ts` (Pixel 7 context) |
| 7 | Page errors, console issues, failed requests | `collect.ts` (both event channels) |
| 8 | Markdown + JSON reports | `artifacts/report.ts`, `write.ts` |
| 9 | Distinguishes setup vs application problems | `verdictDomain` + `domain` field |
| 10 | Conservative blank identification | `diagnose/blank.ts` |
| 11 | Never calls a crashed page healthy | `diagnoseRoute` ordering, test 9 |
| 12 | Redacts obvious secrets | `security/redact.ts`, test 15 |
| 13 | Never kills processes it did not start | `lifecycle.stop()`, `ownership.ts`, test 20 |
| 14 | Claude gets a reusable workflow | project Skill |
| 15 | Automatic verification runs once, not per edit | stale-marker + Stop hook, test 18 |
| 16 | No infinite loops | three mechanisms, test 19 |
| 17 | Tests cover healthy and broken cases | Phase 4 table |
| 18 | Dogfooded on a real frontend | `DOGFOOD_REPORT.md` |
| 19 | README accurate | Phase 5 |
| 20 | No external publishing | nothing published; package is `private: true` |
