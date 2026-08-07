# AgentView

**AgentView verifies that your coding agent is inspecting the frontend belonging to the project it is actually editing — not merely any healthy page answering on localhost.**

More broadly: it verifies that coding agents can inspect the rendered frontend they are changing, captures browser evidence, and identifies which layer failed when they cannot.

> Status: 0.1 release candidate. macOS is the only verified platform. Nothing is published yet.
> **The name is unresolved** — `agentview` is taken on npm by a package that ships a CLI binary of the same name, and a similarly-named tool exists in this category. See [docs/NAMING.md](docs/NAMING.md) and [Limitations](#known-limitations).

## The problem

A coding agent edits your frontend, tries to look at localhost, and something in the chain quietly fails — wrong port, dev server not ready, Chromium missing, the route crashes, the page is blank. The agent falls back to reading source code, assumes the page looks right, and keeps going. You open a real browser and find something obviously broken.

There is a worse version of this, and it is why AgentView exists.

### A healthy page is not evidence

This is real output from developing this tool, against a real Next.js project:

```
HEALTHY_RENDER (confidence: high)
URL        http://localhost:3000/
Navigation HTTP 200
Render     59 visible elements, 549 chars text
```

Green result, HTTP 200, hundreds of elements, no console errors. **It was the wrong application.** Port 3000 belonged to an unrelated project that happened to be running; the project actually being edited was on port 3005. Nothing in the verdict, the status code, or the element counts revealed it. Only opening the screenshot did.

Framework default ports collide constantly. If you keep more than one project running — and most people do — then "something answered on localhost:3000" tells you nothing about *whose* frontend you just verified.

AgentView establishes server identity from the listening process itself: its working directory first, its command line second. Same situation today:

```
$ agentview doctor

  Configured URL
  ! http://localhost:3000 (Next.js default — not configured)

  Port ownership
  ✗ Port 3000 belongs to a different project:
      /Users/example/project-b

  Detected project server
  ✓ Current project is listening on:
      http://localhost:3005
  ✓ Chosen because: matches the configured framework dev command
  ? Also running in this project: 4620 — Python -m http.server 4620

  Recommended actions
  1. The configured port is serving another project. Inspecting it would verify the wrong application.
  2. Update AgentView configuration to port 3005 — run `agentview doctor --fix`.
```

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
  Server     reachable at http://localhost:3005
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

## What this is, and is not

AgentView is the reliability, identity, and diagnosis layer **around** existing browser tooling. It is not a replacement for Playwright, not a browser-automation framework, and not an AI design critic. No API key is needed; every check is deterministic and works offline.

Playwright itself ships an agent-oriented CLI (`npx playwright cli`) and an MCP server, and they are good at what they do. They are **interactive and session-oriented** — the agent opens a session, acts, observes, acts again. AgentView is **one-shot and deterministic**: find the server that belongs to this project, capture a fixed evidence bundle, classify the failure by layer, write durable artifacts, exit with a meaningful status code. Different shape, different job.

### What it honestly does

- Establishes which local server belongs to the project being edited, and refuses to inspect one that does not
- Finds that server **on whatever port it actually landed on**, without configuration
- Verifies Chromium can launch, navigate, and render
- Captures desktop and mobile screenshots plus structured diagnostics
- Separates browser/setup failures from application/runtime failures
- Reports ambiguity instead of guessing when several servers are plausible
- Marks uncertain conclusions as uncertain

### What it does not claim

- It does not permanently fix every Playwright failure
- It does not mean your page is *correct* because it rendered
- It does not repair application code
- It does not bypass authentication, CAPTCHAs, or platform security
- It is not safe for production apps holding sensitive data
- It cannot prove a visually sparse page is accidentally blank
- It does not detect, configure, or validate Playwright MCP — that is not implemented
- It cannot verify server identity where OS process inspection is unavailable, including on Windows; it reports that as unknown rather than guessing

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
agentview fix                # when inspection is broken: repair what is safe, then verify
```

Artifacts land in `.agentview/latest/` (and a timestamped directory under `.agentview/runs/`).

## Commands

| Command | What it does |
|---|---|
| `agentview setup` | Detect framework, package manager, dev command, port; write `.agentview/config.json`; update `.gitignore` |
| `agentview doctor` | Diagnose the chain without changing anything (`--fix` applies safe fixes) |
| `agentview inspect [route]` | Run one inspection and write artifacts |
| `agentview fix [route]` | Attempt safe recovery when inspection is broken, then verify whether it works again |
| `agentview watch` | Re-inspect when frontend files change, debounced |
| `agentview status` | Show config, integration state, and the last result |
| `agentview clean` | Delete generated runs, artifacts, and state |

Useful flags: `--headed` (visible browser), `--json` (machine-readable report on stdout), `--url` (explicit URL, which also resolves ambiguity), `--allow-remote` (permit non-localhost — see [Privacy](docs/PRIVACY.md)), `--allow-foreign-server` (deliberately accept a server belonging to another project).

### Setup options

`--claude` installs the project skill · `--auto <off|advisory|enforced>` sets automatic verification · `--shared` writes hooks to the committed `.claude/settings.json` instead of the personal `settings.local.json` · `--force` re-detects over existing config.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy render |
| `1` | Application problem (crash, blank, failed API, missing route, auth gate) |
| `2` | Setup/environment problem (server, port, browser, ambiguous servers, or `fix` could not repair) |
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

## When inspection is broken: `agentview fix`

Run one command when your coding agent cannot see localhost. AgentView fixes
common setup failures, diagnoses the rest, and verifies that the real frontend
is visible again.

It uses the same discovery and diagnosis code as `doctor` and `inspect` — there
is no second opinion — then applies only repairs it can make confidently, and
**re-inspects to confirm**. A browser launching is not treated as success.

```
$ agentview fix

  FIXED

  ✓ Configuration expected port 3000, but this project's server is on 3210.
    stored expectedPort 3210 in .agentview/config.json.

  Project server found at http://localhost:3210.
  Chromium launched. Application rendered.

  Frontend inspection restored.
```

When the problem is your application, AgentView changes nothing and hands over
the evidence needed to fix it:

```
$ agentview fix

  APPLICATION_FIX_REQUIRED

  Server and browser are healthy.
  The application crashed during render.

  Evidence:
    Uncaught ReferenceError: userProfile is not defined
    GET http://localhost:3210/api/profile → 500

  AgentView made no source-code changes.
  Fix the application, then rerun:
    agentview inspect
```

And when it cannot repair something safely, it says so rather than guessing:

```
$ agentview fix

  COULD_NOT_REPAIR

  Chromium is missing. Safe automatic installation requires user approval.

  Install the supported Chromium build:
    npx playwright install chromium

  Or re-run with --yes to let AgentView do it.
```

### What it repairs, and what it only diagnoses

| Repairs automatically | Diagnoses only |
|---|---|
| A wrong stored port | Application crashes, blank renders, failed APIs, missing routes |
| A dev server that is not running (starts the configured command) | A dev server that exits on startup |
| A dev server that needs longer to become ready | A port held by a process AgentView did not start |
| A corrupt `.agentview/config.json` (backed up, then regenerated) | Several project servers with no clear dev server |
| A stale inspection lock from a crashed run | A missing dev command |
| A missing Chromium build — **only with `--yes`** | A non-localhost configured URL |

Outcomes are `ALREADY_HEALTHY`, `FIXED`, `APPLICATION_FIX_REQUIRED`, or
`COULD_NOT_REPAIR`, with exit codes 0, 0, 1, and 2. `FIXED` is reported only
when a fresh inspection after the repair actually rendered the application.

AgentView will not rewrite your source code, signal a process it did not start,
delete browser profiles, bypass authentication, touch global shell
configuration, use `sudo`, or disable a privacy guard to make a run succeed.

## How it works

```
project config → server identity → dev server → network → browser
   → navigation → application → data/API → rendered interface
```

Each verdict is attributed to one layer, and the report's `domain` field says whether it is a **setup** problem (fix the environment) or an **application** problem (fix your code). Verdicts include `HEALTHY_RENDER`, `LIKELY_BLANK_RENDER`, `PARTIAL_RENDER`, `APPLICATION_RUNTIME_FAILURE`, `FAILED_DEPENDENCY_REQUEST`, `ROUTE_NOT_FOUND`, `AUTHENTICATION_GATE`, `NAVIGATION_FAILED`, `BROWSER_NOT_INSTALLED`, `BROWSER_LAUNCH_FAILED`, `SERVER_START_FAILED`, `SERVER_START_TIMEOUT`, `SERVER_PORT_CONFLICT`, `MULTIPLE_PROJECT_SERVERS`, `DEV_COMMAND_NOT_FOUND`, and `INDETERMINATE`.

Blank-page detection is multi-signal and deliberately conservative — DOM text and element counts, empty app roots, page errors, failed requests, screenshot uniformity, loading indicators, framework error overlays. It reports `true`, `false`, or `uncertain` with confidence and the reasons listed, because an intentionally minimal page looks a lot like a broken one.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the research behind it.

## Supported environments

Support labels are used strictly. "The unit tests pass on that OS" is not support — see [docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md) for the per-feature matrix.

| | Status |
|---|---|
| macOS | **Verified** — the full suite runs here |
| Linux | **Expected** — implemented via `/proc` with an `lsof` fallback, parsers unit-tested against captured output, never run on a Linux host |
| Windows | **Server identity unsupported.** No `lsof` or `/proc`; ownership is reported as unknown rather than approximated. The rest is untested |
| Next.js, Vite | Supported adapters |
| Other Node projects | Generic adapter via a configured dev command |
| Chromium | Supported |
| Firefox / WebKit | Not supported |
| Claude Code | Supported integration |
| Other agents | Core CLI is agent-agnostic; integrations welcome |

## Privacy

No telemetry, no network calls, nothing transmitted. The only requests AgentView makes are to the local server being inspected. Localhost only unless you explicitly opt out. Secrets in headers and query parameters are redacted from saved network data, and request/response bodies are never stored. **Screenshots can contain whatever is on screen, including private data** — artifacts are git-ignored by default. See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- **macOS is the only verified platform.** Linux is implemented but unverified; Windows cannot verify server identity at all.
- **Server identity depends on OS process inspection.** Without it, AgentView reports ownership as unknown and proceeds without that safety net.
- **Rendered is not correct.** `HEALTHY_RENDER` means the page rendered. Judging whether it *looks right* still requires looking at the screenshots.
- **Blank detection is a heuristic**, tuned to avoid false alarms; it reports `uncertain` rather than guessing.
- **Visible-text counts exclude scroll-reveal content** that starts at `opacity: 0`.
- **Only the first screenful is pixel-sampled**, so a page broken far below the fold is not caught by the uniformity signal.
- **Mobile emulation is Pixel 7 under Chromium** — faithful for Android, not iOS/WebKit.
- **Single route per run.** Multi-route inspection is planned.
- **Authenticated routes are reported, not entered.**
- **No Playwright MCP integration.** Detecting or configuring MCP is not implemented.

## Troubleshooting

**"Chromium executable unavailable"** — run `npx playwright install chromium`.

**AgentView says port N belongs to a different project** — it does. Something else is serving that port, and inspecting it would verify the wrong app. Stop it, or point AgentView at the right port with `--url` or `expectedPort`.

**"MULTIPLE_PROJECT_SERVERS"** — several servers are running inside your project directory and none is clearly the dev server. Re-run with `--url http://localhost:<port>`, or stop the ones you are not using. AgentView will not guess.

**"SERVER_PORT_CONFLICT"** — the dev server advertised a port that something else already owns. AgentView will not kill a process it did not start.

**"SERVER_START_TIMEOUT"** — the dev server is slow or prints an unrecognised URL. Raise `startupTimeoutMs` or set `url` explicitly.

**"Process inspection unavailable"** — `lsof`/`proc` could not be used, so ownership cannot be verified. Results are still produced, but without the wrong-project safety net.

**Hooks are not firing** — run `agentview doctor` to confirm the skill and hook are installed and `autoInspect` is not `off`.

## Development

```bash
npm install
npm run build
npm test                  # full suite
npm run test:unit         # fast, no browser or servers
npm run test:integration  # real dev servers and real Chromium
npm run typecheck
```

108 tests across unit, integration, and hook end-to-end coverage. Integration tests start real dev servers and launch real Chromium against fixture projects in temporary directories; the wrong-project suite spawns real child processes with explicit working directories to prove server identity works. No test touches an external website.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding a framework means implementing one `FrameworkAdapter`; adding a platform means implementing one `ProcessInspector`; adding an agent integration means one module under `src/integrations/`.

## License

MIT — see [LICENSE](LICENSE).
