# LocalhostFix

**When Claude Code can't properly see your localhost frontend, run one command.**

LocalhostFix checks the path from your project to the rendered browser, fixes common setup failures, diagnoses application failures, and verifies that the real frontend is visible again.

```bash
npx localhostfix fix
```

> Status: 0.1 release candidate. macOS is the only verified platform. Nothing is published yet.

## The problem

Your coding agent edits the frontend, tries to look at localhost through Playwright, and gets nothing useful back. It falls back to reading source code, assumes the page looks right, and keeps going. You open a real browser and find something obviously broken.

The failure is almost never "Playwright is broken." It is one specific link in a chain, and finding out which one is the tedious part:

- Playwright opens localhost and the page is blank
- the dev server isn't running
- the dev server is running, but on a different port than you configured
- the dev server takes longer to boot than the tool waits
- Chromium was never installed for Playwright
- the server and browser are both fine, and the *application* crashed during render
- another project on your machine is answering on that localhost port

LocalhostFix walks that chain in order, repairs the parts it can repair safely, and tells you exactly which link failed when it can't.

## What `fix` actually does

It runs the same discovery and diagnosis as `doctor` and `inspect` — there is no second opinion — applies only repairs it can make confidently, then **re-inspects to confirm**. A browser launching is not treated as success.

**A repairable problem:**

```
$ npx localhostfix fix

  FIXED

  ✓ Configuration expected port 3000, but this project's server is on 3210.
    stored expectedPort 3210 in .localhostfix/config.json.

  Project server found at http://localhost:3210.
  Chromium launched. Application rendered.

  Frontend inspection restored.
```

**An application problem — LocalhostFix stops and hands over evidence:**

```
$ npx localhostfix fix

  APPLICATION_FIX_REQUIRED

  Server and browser are healthy.
  The application crashed during render.

  Evidence:
    Uncaught ReferenceError: userProfile is not defined
    GET http://localhost:3210/api/profile → 500

  LocalhostFix made no source-code changes.
  Fix the application, then rerun:
    localhostfix inspect
```

**Something it will not do blindly:**

```
$ npx localhostfix fix

  COULD_NOT_REPAIR

  Chromium is missing. Safe automatic installation requires user approval.

  Install the supported Chromium build:
    npx playwright install chromium

  Or re-run with --yes to let LocalhostFix do it.
```

### What it repairs, and what it only diagnoses

| Repairs automatically | Diagnoses, with evidence |
|---|---|
| A wrong stored port | Application crashes, blank renders, failed API requests, missing routes |
| A dev server that isn't running (starts your configured command) | A dev server that exits during startup |
| A dev server that needs longer to become ready | A port held by a process LocalhostFix didn't start |
| A corrupt `.localhostfix/config.json` (backed up, then regenerated) | Several servers running in one project with no clear dev server |
| A stale inspection lock from a crashed run | A missing dev command |
| A missing Chromium build — **only with `--yes`** | A configured URL that isn't localhost |

Outcomes are `ALREADY_HEALTHY`, `FIXED`, `APPLICATION_FIX_REQUIRED`, or `COULD_NOT_REPAIR`, with exit codes 0, 0, 1, and 2. **`FIXED` is reported only when a fresh inspection after the repair actually rendered the application.**

LocalhostFix will not rewrite your source code, signal a process it didn't start, delete browser profiles, bypass authentication, touch global shell configuration, use `sudo`, or disable a privacy guard to make a run succeed.

## What this is, and is not

LocalhostFix is a reliability and diagnosis layer **around** Playwright, not a replacement for it and not a browser-automation framework. No API key is needed; every check is deterministic and works offline.

Honest framing of what it does:

- It fixes common **setup** failures and diagnoses the rest with evidence.
- It verifies the frontend actually renders before reporting success.
- It tells you whether a failure is yours or the environment's.

What it does **not** claim:

- It does not fix Playwright itself, and does not patch it.
- It does not mean Playwright will never break again.
- It does not fix every blank localhost page — a blank page caused by your code is reported, not repaired.
- It does not guarantee frontend access.
- It does not automatically repair application errors. Ever.
- It does not detect, configure, or validate Playwright MCP — that is not implemented.
- It cannot verify which project owns a port where OS process inspection is unavailable, including on Windows; it reports that as unknown rather than guessing.

## Installation

Requires **Node.js 22+** and a Chromium build for Playwright.

```bash
# not yet published to npm — from a local clone:
npm install && npm run build && npm link

# then, in your project:
localhostfix setup
```

If Chromium is missing, LocalhostFix tells you and does not download it behind your back:

```bash
npx playwright install chromium
```

## Quick start

```bash
cd your-project
localhostfix fix               # the one to remember
localhostfix setup --claude    # install the Claude Code skill
localhostfix inspect           # capture evidence for the default route
localhostfix inspect /pricing  # a specific route
localhostfix doctor            # detailed check of the whole chain
```

Artifacts land in `.localhostfix/latest/` (and a timestamped directory under `.localhostfix/runs/`).

## Commands

| Command | What it does |
|---|---|
| `localhostfix fix [route]` | Attempt safe recovery, then verify whether inspection works again |
| `localhostfix doctor` | Diagnose the chain without changing anything (`--fix` applies safe fixes) |
| `localhostfix inspect [route]` | Run one inspection and write artifacts |
| `localhostfix setup` | Detect framework, package manager, dev command, port; write config; update `.gitignore` |
| `localhostfix watch` | Re-inspect when frontend files change, debounced |
| `localhostfix status` | Show config, integration state, and the last result |
| `localhostfix clean` | Delete generated runs, artifacts, and state |

Useful flags: `--headed` (visible browser), `--json` (machine-readable output), `--url` (explicit URL, which also resolves ambiguity), `--yes` (approve installing Chromium), `--allow-remote` (permit non-localhost — see [Privacy](docs/PRIVACY.md)), `--allow-foreign-server` (deliberately accept a server belonging to another project).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy render (or already healthy / fixed) |
| `1` | Application problem (crash, blank, failed API, missing route, auth gate) |
| `2` | Setup/environment problem, or `fix` could not repair it |
| `3` | Indeterminate |
| `4` | CLI usage error |

## Artifacts

```
.localhostfix/
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

`localhostfix setup --claude` installs a project skill at `.claude/skills/localhostfix/SKILL.md` telling Claude to inspect the rendered app before making visual claims, read the report, look at **both** screenshots, and never claim visual verification when inspection failed. It also tells Claude to run `localhostfix fix` when inspection itself is broken, and that `APPLICATION_FIX_REQUIRED` means the repair is Claude's to make.

Optional automatic verification (`--auto advisory` or `--auto enforced`) adds two hooks:

- `PostToolUse` marks frontend verification **stale** after a relevant edit. It is cheap and never launches a browser; edits to backend-only files are ignored.
- `Stop` runs **one** inspection when the state is stale, then feeds the report back to Claude.

So one task that touches twenty components produces one inspection, not twenty. Three independent mechanisms prevent loops: no stale marker means immediate exit, `stop_hook_active` means never block twice in a turn, and a lock file prevents concurrent runs. Disable with `localhostfix setup --auto off`.

Hooks go to `.claude/settings.local.json` by default — personal and git-ignored — so installing LocalhostFix never imposes a browser-launching hook on everyone who clones your repo. Existing settings are merged, never overwritten, and backed up first.

## How it works

```
project config → server identity → dev server → network → browser
   → navigation → application → data/API → rendered interface
```

Each verdict is attributed to one layer, and the report's `domain` field says whether it is a **setup** problem (fix the environment) or an **application** problem (fix your code).

### Server identity: a robustness detail worth knowing

A reachable URL is not evidence that it belongs to *your* project. Framework default ports collide constantly, and during development this tool once returned a confident `HEALTHY_RENDER` for a completely different application that happened to own port 3000.

LocalhostFix establishes identity from the listening process itself — its working directory first, its command line second — so it finds your project's server on whatever port it actually landed on, and refuses to inspect a neighbour's:

```
  Port ownership
  ✗ Port 3000 belongs to a different project:
      /Users/example/project-b

  Detected project server
  ✓ Current project is listening on:
      http://localhost:3005
  ✓ Chosen because: matches the configured framework dev command
```

Blank-page detection is multi-signal and deliberately conservative — DOM text and element counts, empty app roots, page errors, failed requests, screenshot uniformity, loading indicators, framework error overlays. It reports `true`, `false`, or `uncertain` with confidence and reasons, because an intentionally minimal page looks a lot like a broken one.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the research behind it.

## Supported environments

Support labels are used strictly. "The unit tests pass on that OS" is not support — see [docs/PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md).

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

No telemetry, no network calls, nothing transmitted. The only requests LocalhostFix makes are to the local server being inspected. Localhost only unless you explicitly opt out. Secrets in headers and query parameters are redacted from saved network data, and request/response bodies are never stored. **Screenshots can contain whatever is on screen, including private data** — artifacts are git-ignored by default. See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- **macOS is the only verified platform.** Linux is implemented but unverified; Windows cannot verify server identity at all.
- **Rendered is not correct.** `HEALTHY_RENDER` means the page rendered. Judging whether it *looks right* still requires looking at the screenshots.
- **Blank detection is a heuristic**, tuned to avoid false alarms; it reports `uncertain` rather than guessing.
- **Visible-text counts exclude scroll-reveal content** that starts at `opacity: 0`.
- **Only the first screenful is pixel-sampled**, so a page broken far below the fold is not caught by the uniformity signal.
- **Mobile emulation is Pixel 7 under Chromium** — faithful for Android, not iOS/WebKit.
- **Single route per run.** Multi-route inspection is planned.
- **Authenticated routes are reported, not entered.**

## Troubleshooting

**Start with `localhostfix fix`.** Most of the cases below are what it exists to handle.

**"Chromium executable unavailable"** — run `npx playwright install chromium`, or `localhostfix fix --yes`.

**LocalhostFix says port N belongs to a different project** — it does. Something else is serving that port, and inspecting it would verify the wrong app. Stop it, or point LocalhostFix at the right port with `--url` or `expectedPort`.

**"MULTIPLE_PROJECT_SERVERS"** — several servers are running inside your project directory and none is clearly the dev server. Re-run with `--url http://localhost:<port>`, or stop the ones you are not using. LocalhostFix will not guess.

**"SERVER_START_TIMEOUT"** — the dev server is slow or prints an unrecognised URL. `fix` raises the timeout and retries; you can also set `url` explicitly.

**"Process inspection unavailable"** — `lsof`/`/proc` could not be used, so ownership cannot be verified. Results are still produced, but without the wrong-project safety net.

**Hooks are not firing** — run `localhostfix doctor` to confirm the skill and hook are installed and `autoInspect` is not `off`.

**You see a `.agentview/` directory** — that is from the previous name of this tool, before it was released. Move it with `mv .agentview .localhostfix`, or delete it. Nothing reads it.

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
