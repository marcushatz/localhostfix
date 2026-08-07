# AgentView — Dogfood Report

> Two dogfooding passes are recorded here: the original v0.1 build, and the
> pre-release hardening pass that followed. Read the
> [release-candidate section](#release-candidate-dogfood-2026-08-07) for the
> current state of the tool.

Date: 2026-08-07 · Platform: macOS (darwin 25.5.0, arm64) · Node 25.2.1 · Playwright 1.62.1 (Chromium build 1234)

Target: **`/Users/example/project-a`** — a real Next.js 16.2.9 marketing site, chosen because it is the application that previously suffered unreliable localhost inspection.

The application source was **not modified** to make AgentView look good. AgentView was run without `agentview setup`, so it never touched the project's `.gitignore` or settings; its only writes were to `.agentview/`, which was removed afterwards. Verified clean at the end: `.agentview` absent, zero AgentView entries in `git status`, `.gitignore` unchanged. (The modified files shown in that repo's `git status` are the developer's own pre-existing work.)

## Headline result

Dogfooding found **four real defects** that the fixture tests did not, three of them cases where AgentView confidently reported success while looking at the **wrong application**. Every one is now fixed and covered by a regression test. This is the strongest evidence in the project that the tool does what it claims — and that testing only the happy path would have shipped something dishonest.

---

## Defect 1 — a reachable URL was assumed to be our server

**How it surfaced.** The very first end-to-end run used a throwaway fixture that logged `http://localhost:4599` while actually listening on 4611 (a `sed` had replaced only the first match on the line). AgentView parsed the advertised URL, probed it, got HTTP 200 from an unrelated process already on 4599, and reported:

```
HEALTHY_RENDER (confidence: high)
Render: 723 visible elements, 8726 chars text, title "Example App — Website design & SEO…"
```

A perfect green result for an application that was never being inspected.

**Why it matters.** This is exactly the product's reason to exist. A dev server advertising a port it does not serve, or a stale process holding a port, silently redirects verification to the wrong app.

**Fix.** `src/server/ownership.ts`: when AgentView starts a dev server, it resolves which PID listens on the candidate port (`lsof`) and verifies that process descends from the tree it spawned. Foreign owners are rejected; if only a foreign owner is ever reachable, the run ends as `SERVER_PORT_CONFLICT` naming the process. Re-running the same broken fixture afterwards:

```
SERVER_PORT_CONFLICT (confidence: high)
 - http://localhost:4599 is reachable but is served by a process AgentView
   did not start: Python (pid 51789)
 - Inspecting it would have verified a different application than the one
   being developed.
Next action: Stop whatever is already using that port, or point AgentView at
the right one … AgentView will not terminate a process it did not start.
```

**Regression test.** `test/integration/artifacts.test.ts` → "a dev server advertising a port owned by someone else is a conflict, not a healthy render".

---

## Defect 2 — reusing a *neighbouring project's* dev server

**How it surfaced.** Running against the real project produced `HEALTHY_RENDER` at `http://localhost:3000`. Reading the captured screenshot showed a completely different product — an app called "Project B" — whose dev server already owned port 3000. AgentView had reused it because 3000 is the Next.js default.

This one is instructive: the verdict, the status code, and the element counts were all "fine". Only *looking at the screenshot* exposed it, which is precisely the discipline the tool asks agents to follow.

**Fix.** The reuse path now verifies the listening process's working directory against the project root (`checkServerProject`). A server belonging to a different project is skipped rather than reused, AgentView starts its own instead, and the report records what was skipped and why. `--allow-foreign-server` is the deliberate opt-out.

---

## Defect 3 — `/` as a working directory matched every project

**How it surfaced.** After adding directory matching, a run selected `http://localhost:7000` and failed with `NAVIGATION_FAILED … ERR_HTTP_RESPONSE_CODE_FAILURE`. Port 7000 is macOS AirPlay; its process runs with cwd `/`, and the containment check treated "`/` contains the project" as a match.

**Fix.** `classifyCwd()` now distinguishes `inside` (the project root or below — which correctly covers monorepo packages) from `contains` (an ancestor, which proves nothing) from `unrelated`. Only `inside` counts as a match; `contains` is reported as unknown and never blocks.

**Regression test.** `test/unit/ownership.test.ts` — including that `/`, `/Users/dev`, and a `app-backup` sibling are all correctly rejected.

---

## Defect 4 — picking the wrong server among several in the same project

**How it surfaced.** With directory matching working, AgentView chose `http://localhost:4620` — a leftover `python -m http.server` running inside the project directory — while the actual Next.js dev server was on **3005**. Both legitimately belonged to the project, so both matched; ordering was arbitrary.

**Fix.** `FrameworkAdapter` gained `devProcessPatterns`, and discovered servers are ranked by whether the owning process looks like that framework's dev server (`next-server`, `vite`, …). The Next.js server now wins.

**Bonus capability.** This work produced something better than the original design: AgentView now **discovers a running dev server for the project on any port**, by enumerating listeners and matching working directories. The brief's "which port does it actually use?" pain point is answered without the developer configuring anything — port 3005 was found with no config file present.

---

## Defect 5 — blank-page heuristic too aggressive

**How it surfaced.** A small but perfectly healthy fixture page (a heading, a paragraph, a link, a button) was classified `PARTIAL_RENDER` because its full-page screenshot was ~100% one colour.

**Fix.** A uniform screenshot now counts as *strong* blank evidence only when the DOM is also empty; on its own it is weak. A fast path exits early with `likelyBlank: false` when a page has real text, real elements, and something interactive. Pixel sampling was also restricted to the first screenful, since below the fold is mostly background on long pages.

**Regression test.** `test/unit/blank.test.ts` → "a uniform screenshot alone never makes a content-bearing page blank".

---

## Final verified runs against the real application

All commands run from `/Users/example/project-a` with no AgentView config present.

### `agentview doctor`

```
  AGENTVIEW DOCTOR

  Project
  ✓ Project root: /Users/example/project-a
  ✓ Framework: Next.js
  ✓ Package manager: npm
  ✓ Development command: npm run dev
  ! No AgentView config yet (defaults in use) — run `agentview setup`

  Server
  ✓ Already running and reachable: http://localhost:3000 (HTTP 200)

  Browser
  ✓ Playwright package available (bundled with AgentView)
  ✓ Chromium executable: …/ms-playwright/chromium-1234/…/Google Chrome for Testing
  ✓ Chromium launches successfully

  Claude integration
  ! Project skill not installed — run `agentview setup --claude`
  ! Automatic verification hook not enabled
```

Known limitation visible here — **since fixed**: `doctor` probed only the configured/default port for its "already running" line, so it reported the neighbouring app on 3000 as though it were this project's. `inspect` already performed full project-ownership discovery, and the two disagreeing was itself the bug. Both now share `src/server/discovery.ts`; see the [release-candidate section](#release-candidate-dogfood-2026-08-07) for the corrected output.

### `agentview inspect` — healthy render

```
HEALTHY_RENDER (confidence: high)
URL        http://localhost:3005/
Server     reachable at http://localhost:3005 (reused)
Browser    Chromium launched
Navigation HTTP 200
Render     776 visible elements, 8726 chars text
Next action Rendering succeeded. Inspect desktop.png and mobile.png to verify
            the visual result — a rendered page is not automatically a correct page.
```

Exit code `0`. Artifacts (copied into this repo as evidence):

| Artifact | Path in this repo | Notes |
|---|---|---|
| Markdown report | `docs/dogfood-artifacts/healthy-report.md` | |

Both screenshots were opened and confirmed to show the correct application.

### `agentview inspect /this-route-does-not-exist` — failure and diagnosis

```
ROUTE_NOT_FOUND (confidence: high)
Navigation HTTP 404
Evidence   - main document returned HTTP 404 for
             http://localhost:3005/this-route-does-not-exist
Next action The route /this-route-does-not-exist does not exist on this server.
```

Exit code `1` (application domain — correctly *not* blamed on tooling). Artifacts: `docs/dogfood-artifacts/route-404-report.md` and `route-404-report.json`.

### Recovery and second inspection

Re-running `agentview inspect` on the valid route after the 404 returned `HEALTHY_RENDER` with exit code `0`, confirming the failure was route-specific and that no state leaked between runs.

### Exit-code verification

```
$ agentview inspect /nope   → exit 1   (application problem)
$ agentview inspect         → exit 0   (healthy)
```

---

## Process-hygiene verification

Across every dogfood run AgentView **reused** the developer's existing dev server and never terminated it — the Next.js server on 3005 and the Python server on 4620 were both still running afterwards. No process AgentView did not start was ever signalled. The integration suite additionally asserts that servers AgentView *does* start are stopped and their ports freed.

## Known limitations exposed by dogfooding

1. ~~**`doctor` and `inspect` use different server-discovery logic.**~~ **Fixed in the hardening pass** — both now use `src/server/discovery.ts`, and a regression test asserts `doctor` cannot report a foreign project's server as this project's.
2. **Port-ownership checks depend on `lsof`.** On systems without it (some containers) ownership resolves to `unknown` and AgentView proceeds without the safety net rather than blocking. Correct behaviour, but the guarantee is weaker there.
3. **`visibleTextLength` counts only elements visible at load.** Scroll-reveal sections that start at `opacity: 0` are excluded, so text counts understate content on animation-heavy pages. This affects the blank heuristic's inputs, though the conservative thresholds absorbed it here.
4. **Only the first screenful is pixel-sampled.** A page that renders correctly above the fold but is broken far below would not be caught by the uniformity signal.
5. **Mobile emulation uses Pixel 7 under Chromium.** Faithful for Android and for `pointer: coarse` media queries; it is not iOS/WebKit rendering.


---

# Release-candidate dogfood (2026-08-07)

Re-run after the hardening pass that aligned `doctor` with `inspect`, added the
`MULTIPLE_PROJECT_SERVERS` verdict, isolated OS-specific work behind
`ProcessInspector`, and moved the localhost guard into discovery.

Target again: `/Users/example/project-a` (Next.js 16.2.9),
read-only. No `agentview setup` was run there, so its `.gitignore` was never
touched; the only writes were to `.agentview/`, removed afterwards. Verified
clean at the end: directory absent, zero AgentView entries in `git status`,
`.gitignore` unchanged.

## The decisive scenario

The machine was in exactly the state that produces the failure this tool
exists to prevent:

| Port | Owner |
|---|---|
| 3000 | **A different project** (`/Users/example/project-b`) |
| 3005 | The real example-next-app Next.js dev server |
| 4599, 4620 | Leftover `python -m http.server` processes inside the project |

`agentview doctor --no-server`, verbatim:

```
  Configured URL
  ! http://localhost:3000 (Next.js default — not configured)

  Port ownership
  ✗ Port 3000 belongs to a different project:
      /Users/example/project-b

  Detected project server
  ✓ Current project is listening on:
      http://localhost:3005
  ✓ Chosen because: matches the configured framework dev command
  ? Also running in this project: 4599 — Python -m http.server 4599
  ? Also running in this project: 4620 — Python -m http.server 4620
  ! Configuration expects port 3000, but this project's server is on 3005

  Recommended actions
  1. The configured port is serving another project. Inspecting it would verify the wrong application.
  2. Update AgentView configuration to port 3005 — run `agentview doctor --fix`.
```

Exit code `2`. Before this pass, `doctor` probed only the configured port and
would have reported "Already running and reachable: http://localhost:3000" —
health for someone else's application. That regression is now covered by
`test/integration/wrong-project.test.ts`, which asserts `doctor` names the
offending directory and does not exit 0.

`agentview inspect` on the same machine state selected the correct server
without any configuration:

```
  HEALTHY_RENDER (confidence: high)
  URL        http://localhost:3005/
  Server     reachable at http://localhost:3005 (reused)
  Navigation HTTP 200
  Render     806 visible elements, 9600 chars text
```

Exit code `0`. The desktop screenshot was opened and confirmed to be the
Example App site (its own branding, founder quote, and the four portfolio entries)
— not the neighbouring project.

Artifacts: `docs/dogfood-artifacts/rc-healthy-report.md`,
`docs/dogfood-artifacts/rc-doctor-output.txt`.

## Scenarios covered

| # | Scenario | Result |
|---|---|---|
| 1 | Healthy fixture | `HEALTHY_RENDER`, exit 0, both screenshots produced |
| 2 | Broken fixtures (crash, blank, 500, 404, auth, start failure, timeout) | Correct verdict per case, exit 1 or 2 by domain |
| 3 | Configured port occupied by another project | Refused; `doctor` fails with the offending directory named |
| 4 | Project's real server on a different port | Found by directory attribution, no configuration needed |
| 5 | Real example-next-app project, read-only | As above; cleaned up, `git status` unchanged |

Scenarios 1–4 are automated in `test/integration/`, so they cannot silently
regress. Scenario 3 in particular spawns a real child process with an explicit
working directory rather than simulating one.

## New findings from this pass

**A missing dev command was reported too early.** `inspect` bailed with
`DEV_COMMAND_NOT_FOUND` before discovery ran, so a project whose server was
already running still failed if it had no dev script. The check now happens
only when nothing is running and AgentView actually needs to start something.

**`doctor` could contact a remote host.** It probed a configured URL without
checking it was localhost, so a remote `url` in `.agentview/config.json` would
have been contacted without `--allow-remote`. The guard now lives inside
`discoverServers`, the only code that makes requests, so no caller can bypass
it. Covered by a test using an unroutable TEST-NET-3 address.

**Redaction was verified adversarially, with a negative control.** A fixture
leaks fake secrets through `authorization`, `cookie`, `x-api-key`,
`x-csrf-token`, and query parameters; every generated artifact is then scanned
for them. To confirm the test has teeth rather than passing vacuously, the same
fixture was run with `redact: false` — the secrets *do* appear in
`network.json`, proving redaction is what removes them.

**`watch` could orphan a dev server.** It had no signal handling, so an
interrupt during an inspection could leave a spawned server running. It now
finishes the in-flight run before exiting, with a second Ctrl-C to force.

**CLI output leaked absolute paths** and `setup` reported success even when it
had found no dev command — moving the failure to the next command instead of
naming it.

## Limitations confirmed, not fixed

1. **Scroll-reveal content is not counted or captured.** The example-next-app
   full-page screenshot shows large empty regions because sections start at
   `opacity: 0` and animate in on scroll. AgentView captures the page as it is
   at load, so `visibleTextLength` understates content on animation-heavy
   pages. The conservative blank thresholds absorb this, but a page whose
   content *only* appears after scrolling would look sparser than it is.
2. **Port-ownership checks depend on OS process inspection.** Where
   unavailable, ownership is `unknown` and AgentView proceeds without the
   safety net rather than blocking. Windows has no implementation at all — see
   `docs/PLATFORM_SUPPORT.md`.
3. **Only the first screenful is pixel-sampled**, so breakage far below the
   fold is not caught by the uniformity signal.
4. **Mobile emulation is Pixel 7 under Chromium** — faithful for Android and
   for `pointer: coarse`, not iOS/WebKit.
5. **`doctor --no-server` was used** for the read-only runs above. The
   server-starting path is exercised by the integration suite rather than
   against the developer's live project.
