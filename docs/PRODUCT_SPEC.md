# AgentView — Product Specification (v0.1)

## One sentence

AgentView verifies that a coding agent can actually inspect the frontend it is changing: it starts or finds the local dev server, opens the rendered app in Chromium, captures browser evidence, and explains which layer failed when inspection does not work.

## The problem

Coding agents (Claude Code and others) frequently edit frontends without reliably seeing the rendered result. The typical failure chain:

1. The agent edits frontend code.
2. It tries to inspect localhost via Playwright, Playwright MCP, or another browser tool.
3. Something in the chain fails: wrong port, dev server not ready, Chromium missing, route crashes, blank page, or the browser integration fails silently.
4. The agent keeps editing based on source code alone and assumes the UI is fine.
5. The developer opens a real browser and finds an obviously broken page, then manually debugs the whole chain (server? port? route? browser install? JS crash? failed API? auth wall?).

AgentView replaces that manual debugging with one deterministic, evidence-producing command.

## What AgentView is

- A CLI developer tool (`agentview setup | doctor | inspect | watch`).
- A reliability, diagnosis, artifact-generation, and agent-workflow layer **around** existing browser tooling (Playwright).
- A project-level Claude Code integration (Skill + optional hook-based automatic verification).

## What AgentView is not

- Not a replacement for Playwright or a new browser-automation framework.
- Not an AI design critic. No AI/API key is needed for any core function.
- Not a test runner or a replacement for Playwright MCP in every use case.

## Honest claims (what we promise)

- Verifies the dev server is reachable; discovers or confirms the real local URL and port.
- Verifies the browser can launch, navigate, and render.
- Captures desktop + mobile screenshots and structured diagnostics (page errors, console errors, failed requests).
- Distinguishes browser/setup failures from application/runtime failures.
- Applies only clearly safe automated fixes, each recorded and reversible.
- Gives coding agents a repeatable inspection workflow and marks uncertain conclusions as uncertain.

## Explicit non-claims (we must never state)

- That every Playwright failure is permanently fixed.
- That a page is *correct* because it rendered.
- That arbitrary application code can be repaired automatically.
- That auth, CAPTCHAs, or platform security can be bypassed.
- That production apps with sensitive data can be inspected safely.
- That a visually sparse page is *certainly* an accidental blank.
- That Playwright MCP is unnecessary in every use case.

## v0.1 target

- **Platform:** macOS first (architecture keeps Windows/Linux addable).
- **Project types:** Node.js — Next.js, Vite, plus a configurable generic dev command.
- **Browser:** Chromium (via Playwright).
- **Agent integration:** Claude Code (core CLI stays agent-agnostic so Codex/Cursor/Copilot can be added later).

## Commands (v0.1)

| Command | Purpose |
|---|---|
| `agentview setup` | One-time project configuration; `--claude` installs the Claude Code integration |
| `agentview doctor` | Diagnose the full inspection chain without modifying anything (`--fix` applies safe fixes) |
| `agentview inspect [route]` | Run one full inspection and produce artifacts |
| `agentview fix [route]` | Attempt safe recovery, then verify whether inspection works again |
| `agentview watch` | Watch frontend files, debounce, re-run inspections |
| `agentview status` | Show config, last run result, and integration state |
| `agentview clean` | Remove AgentView-generated runs/state |

## The layer model (central product idea)

Every failure is attributed to a specific layer, in order:

```
project configuration
→ development server
→ network reachability
→ browser launch
→ page navigation
→ application execution
→ data/API loading
→ rendered interface
→ agent artifact access
```

Verdicts (see ARCHITECTURE.md for the full classification): PROJECT_NOT_RECOGNIZED, DEV_COMMAND_NOT_FOUND, SERVER_START_FAILED, SERVER_START_TIMEOUT, SERVER_UNREACHABLE, PORT_MISMATCH, BROWSER_NOT_INSTALLED, BROWSER_LAUNCH_FAILED, NAVIGATION_FAILED, ROUTE_NOT_FOUND, AUTHENTICATION_GATE, APPLICATION_RUNTIME_FAILURE, FAILED_DEPENDENCY_REQUEST, LIKELY_BLANK_RENDER, PARTIAL_RENDER, HEALTHY_RENDER, INDETERMINATE.

## Artifacts

Each inspection writes a timestamped run directory plus a `latest` pointer:

```
.agentview/
  config.json          # committed project config
  state/               # AgentView-owned process metadata (gitignored)
  runs/<timestamp>/    # gitignored
    report.md          # concise, agent-readable narrative
    report.json        # stable, documented schema for hooks/tools
    desktop.png  mobile.png
    console.json  network.json  page-errors.json
    server.log   metadata.json
  latest/              # copy of most recent run
```

## Blank-page detection

Conservative, multi-signal, confidence-scored. Signals: main-document status, title, body dimensions, visible element count, visible text length, known app-root presence/emptiness (`#root`, `#__next`, etc.), page errors, console errors, failed critical requests, near-uniform screenshot pixels, persistent loading indicators, framework error overlays. Output is `likelyBlank: true|false|uncertain` with confidence and listed evidence — never a bare boolean from one heuristic.

## Safe automatic fixes (allowed)

Store detected URL/port; install supported Chromium after explicit approval; create isolated browser profile; repair AgentView's own config/files/integration; wait longer for server readiness; headless fallback; remove stale AgentView-owned process metadata; terminate only processes AgentView itself started and positively identifies. Every fix records: what was wrong, what changed, success, and how to undo.

**Never:** rewrite app source, kill unrelated processes, touch user browser profiles, modify global shell config or Claude global config, alter auth state, disable SSL, use sudo, or claim a setup fix repaired the application.

## Claude Code integration

- **Project Skill** — teaches Claude: inspect before making frontend claims; run AgentView after frontend changes; read report + both screenshots + errors; never claim visual verification when inspection failed; distinguish setup failure from app failure.
- **Automatic verification (optional)** — debounced dirty-state model: frontend edits mark verification stale; one inspection runs at task-completion time (Stop hook); the report is fed back to Claude. Modes: `off` / `advisory` / `enforced` (default `advisory`). Loop-safe by design.
- **MCP** — NOT IMPLEMENTED in v0.1. AgentView neither detects nor configures Playwright MCP. Its inspection has never required an MCP connection, which was the point of the architecture; helping configure MCP remains a possible future addition.

## Privacy & security posture (v0.1)

Localhost-only by default; explicit override + warning for remote URLs; zero telemetry; nothing transmitted anywhere; auth headers/cookies/tokens/sensitive query params redacted from saved network data; request/response bodies not stored by default; run artifacts gitignored; isolated browser state. Details in SECURITY.md and PRIVACY.md.

## Naming note

**Unresolved release blocker.** The npm name `agentview` is taken by a package that ships a CLI binary of the same name, the `@agentview` scope is owned by that same author (so the `@agentview/cli` placeholder can never be published), `github.com/agentview` is taken by a project in this category, and a ~3K-star tool called AgentsView occupies adjacent mindshare. Full evidence and recommendations in [NAMING.md](NAMING.md).

## Acceptance criteria

The 20 criteria in the project brief (§20) are the release gate for v0.1; docs/IMPLEMENTATION_PLAN.md maps each to implementation and tests.
