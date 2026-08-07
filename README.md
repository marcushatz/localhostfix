# AgentView

**AgentView verifies that your coding agent can inspect the frontend it is changing.** It starts or finds the local development server, opens the rendered application in Chromium, captures browser evidence, and explains which layer failed when inspection does not work.

> Status: 0.1, macOS-first, not yet published. See [Limitations](#known-limitations).

## The problem

A coding agent edits your frontend, tries to look at localhost, and something in the chain quietly fails — wrong port, dev server not ready, Chromium missing, the route crashes, the page is blank, or the browser integration returns nothing useful. The agent falls back to reading source code, assumes the page looks right, and keeps going. You open a real browser and find something obviously broken.

Then you debug the chain by hand: did the server start? which port? does the route exist? is Playwright installed? did JavaScript crash? did an API fail? is there an auth wall? did the agent actually receive a screenshot?

AgentView turns that into one command that produces evidence and names the layer that failed.

## Before and after

**Before**

```
Agent: I've updated the hero section. The layout now looks balanced on
       desktop and mobile.
You:   [opens localhost] The page is blank.
```

**After**

```
$ agentview inspect

  APPLICATION_RUNTIME_FAILURE (confidence: high)

  URL        http://localhost:3005/
  Server     reachable at http://localhost:3005 (reused)
  Browser    Chromium launched
  Navigation HTTP 200
  Render     2 visible elements, 0 chars text
  Problems   1 page errors, 0 console errors, 1 failed requests

  Evidence
   - Uncaught ReferenceError: userProfile is not defined
   - GET http://localhost:3005/api/profile → 500

  Next action Fix the application error first (Uncaught ReferenceError:
  userProfile is not defined) before changing visual styling. This is an app
  bug, not a tooling problem.
```

The agent reads that report, sees the crash, and fixes the actual bug instead of restyling a page it cannot see.

## What this is, and is not

AgentView is the reliability, diagnosis, and artifact layer **around** existing browser tooling. It is not a replacement for Playwright, not a new browser-automation framework, and not an AI design critic. No API key is needed; every check is deterministic and works offline.

Playwright itself now ships an agent-oriented CLI (`npx playwright cli`) and an MCP server, and they are good. They are **interactive and session-oriented** — the agent opens a session, acts, observes, acts again. AgentView is **one-shot and deterministic**: boot or find the server, capture a fixed evidence bundle, classify the failure by layer, write durable artifacts, exit with a meaningful status code. Different shape, different job. AgentView can detect and validate a Playwright MCP setup, but never requires one.

### What it honestly does

- Verifies the dev server is reachable, and finds it **on whatever port it actually landed on**
- Verifies Chromium can launch, navigate, and render
- Captures desktop and mobile screenshots plus structured diagnostics
- Separates browser/setup failures from application/runtime failures
- Applies only clearly safe automated fixes, each recorded and reversible
- Marks uncertain conclusions as uncertain

### What it does not claim

- It does not permanently fix every Playwright failure
- It does not mean your page is *correct* because it rendered
- It does not repair application code
- It does not bypass authentication, CAPTCHAs, or platform security
- It is not safe for production apps holding sensitive data
- It cannot prove a visually sparse page is accidentally blank
- It does not make Playwright MCP unnecessary in every use case

## Installation

Requires **Node.js 22+** and a Chromium build for Playwright.

```bash
# not yet published to npm — from a local clone:
npm install && npm run build && npm link

# then, in your project:
agentview setup
```

If Chromium is missing, AgentView tells you and does not download it behind your back:

```bash
npx playwright install chromium
```

## Quick start

```bash
cd your-project
agentview setup --claude     # detect the project, install the Claude Code skill
agentview doctor             # check the whole chain
agentview inspect            # inspect the default route
agentview inspect /pricing   # inspect a specific route
```

Artifacts land in `.agentview/latest/` (and a timestamped directory under `.agentview/runs/`).

## Commands

| Command | What it does |
|---|---|
| `agentview setup` | Detect framework, package manager, dev command, port; write `.agentview/config.json`; update `.gitignore` |
| `agentview doctor` | Diagnose the chain without changing anything (`--fix` applies safe fixes) |
| `agentview inspect [route]` | Run one inspection and write artifacts |
| `agentview watch` | Re-inspect when frontend files change, debounced |
| `agentview status` | Show config, integration state, and the last result |
| `agentview clean` | Delete generated runs, artifacts, and state |

Useful flags: `--headed` (visible browser), `--json` (machine-readable report on stdout), `--url` (explicit URL), `--allow-remote` (permit non-localhost — see [Privacy](docs/PRIVACY.md)), `--allow-foreign-server` (accept a server belonging to another project).

### Setup options

`--claude` installs the project skill · `--auto <off|advisory|enforced>` sets automatic verification · `--shared` writes hooks to the committed `.claude/settings.json` instead of the personal `settings.local.json` · `--force` re-detects over existing config.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy render |
| `1` | Application problem (crash, blank, failed API, missing route, auth gate) |
| `2` | Setup/environment problem (server, port, browser) |
| `3` | Indeterminate |
| `4` | CLI usage error |

## Artifacts

```
.agentview/
  config.json          # committed
  runs/<timestamp>/    # git-ignored
    report.md          # concise narrative for an agent to read
    report.json        # stable schema for hooks and tools
    desktop.png  mobile.png
    console.json  network.json  page-errors.json
    server.log   snapshot.yml
  latest/              # copy of the most recent run
```

## Claude Code integration

`agentview setup --claude` installs a project skill at `.claude/skills/agentview/SKILL.md` telling Claude to inspect the rendered app before making visual claims, read the report, look at **both** screenshots, and never claim visual verification when inspection failed.

Optional automatic verification (`--auto advisory` or `--auto enforced`) adds two hooks:

- `PostToolUse` marks frontend verification **stale** after a relevant edit. It is cheap and never launches a browser; edits to backend-only files are ignored.
- `Stop` runs **one** inspection when the state is stale, then feeds the report back to Claude.

So one task that touches twenty components produces one inspection, not twenty. Three independent mechanisms prevent loops: no stale marker means immediate exit, `stop_hook_active` means never block twice in a turn, and a lock file prevents concurrent runs. `advisory` never blocks; `enforced` blocks once with the diagnosis when the verdict is unhealthy. Disable with `agentview setup --auto off`.

Hooks go to `.claude/settings.local.json` by default — personal and git-ignored — so installing AgentView never imposes a browser-launching hook on everyone who clones your repo. Existing settings are merged, never overwritten, and backed up first.

## How it works

```
project config → dev server → network → browser → navigation
   → application → data/API → rendered interface → agent artifacts
```

Each verdict is attributed to one layer, and the report's `domain` field says whether it is a **setup** problem (fix the environment) or an **application** problem (fix your code). Verdicts include `HEALTHY_RENDER`, `LIKELY_BLANK_RENDER`, `PARTIAL_RENDER`, `APPLICATION_RUNTIME_FAILURE`, `FAILED_DEPENDENCY_REQUEST`, `ROUTE_NOT_FOUND`, `AUTHENTICATION_GATE`, `NAVIGATION_FAILED`, `BROWSER_NOT_INSTALLED`, `BROWSER_LAUNCH_FAILED`, `SERVER_START_FAILED`, `SERVER_START_TIMEOUT`, `SERVER_PORT_CONFLICT`, `DEV_COMMAND_NOT_FOUND`, and `INDETERMINATE`.

Blank-page detection is multi-signal and deliberately conservative — DOM text and element counts, empty app roots, page errors, failed requests, screenshot uniformity, loading indicators, framework error overlays. It reports `true`, `false`, or `uncertain` with confidence and the reasons listed, because an intentionally minimal page looks a lot like a broken one.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design and the research behind it.

## Supported environments

| | Status |
|---|---|
| macOS | Supported and tested |
| Linux / Windows | Should mostly work; port-ownership checks need `lsof`. Untested |
| Next.js, Vite | Supported adapters |
| Other Node projects | Generic adapter via a configured dev command |
| Chromium | Supported |
| Firefox / WebKit | Not yet |
| Claude Code | Supported integration |
| Other agents | Core CLI is agent-agnostic; integrations welcome |

## Privacy

No telemetry, no network calls, nothing transmitted. Localhost only unless you explicitly opt out. Secrets in headers and query parameters are redacted from saved network data, and request/response bodies are never stored. **Screenshots can contain whatever is on screen, including private data** — artifacts are git-ignored by default. See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- **macOS-first.** Other platforms are not yet tested.
- **`doctor` and `inspect` discover servers differently.** `doctor` probes the configured/default port only; `inspect` does full project-ownership discovery and can therefore find servers `doctor` misses. Being aligned in 0.2.
- **Port-ownership verification needs `lsof`.** Without it, ownership is `unknown` and AgentView proceeds without that safety net.
- **Rendered is not correct.** `HEALTHY_RENDER` means the page rendered. Judging whether it *looks right* still requires looking at the screenshots.
- **Blank detection is a heuristic.** It is tuned to avoid false alarms, so it will report `uncertain` rather than guess.
- **Visible-text counts exclude scroll-reveal content** that starts at `opacity: 0`.
- **Mobile emulation is Pixel 7 under Chromium** — faithful for Android, not iOS/WebKit.
- **Single route per run.** Multi-route inspection is planned.
- **Authenticated routes are reported, not entered.**

## Troubleshooting

**"Chromium executable unavailable"** — run `npx playwright install chromium`.

**"SERVER_PORT_CONFLICT"** — something else owns the port your dev server advertised. Stop it, or set `url`/`expectedPort` in `.agentview/config.json`. AgentView will not kill a process it did not start.

**AgentView inspected the wrong app** — it now verifies that a server belongs to your project before reusing it. If you *want* a server from another directory, pass `--allow-foreign-server`.

**"SERVER_START_TIMEOUT"** — the dev server is slow or prints an unrecognised URL. Raise `startupTimeoutMs` or set `url` explicitly.

**The report says the page is blank but it looks fine** — check `likelyBlank` and its reasons in `report.json`; `uncertain` means AgentView is telling you it could not decide.

**Hooks are not firing** — run `agentview doctor` to confirm the skill and hook are installed and `autoInspect` is not `off`.

## Development

```bash
npm install
npm run build
npm test              # 72 tests: unit, integration, and hook end-to-end
npm run typecheck
```

Integration tests start real dev servers and launch real Chromium against fixture projects in temporary directories. No test touches an external website.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding a framework means implementing one `FrameworkAdapter`; adding an agent integration means one module under `src/integrations/`.

## License

MIT — see [LICENSE](LICENSE).
