# AgentView — Architecture

## Foundation decision: which browser layer to build on

The brief asked for an explicit comparison of four possible foundations. Research was done against current official sources (Playwright 1.62.1 docs and repo, plus live probes of the installed package — see "Verified findings" below).

| Option | What it is | Verdict for AgentView |
|---|---|---|
| **1. Direct Playwright Node API** (`playwright-core`) | Library: launch browser, navigate, capture | **Chosen for the core engine** |
| 2. Playwright's agent CLI (`npx playwright cli`, new in 1.62) | Stateful, session-oriented CLI that lets an agent drive a browser step by step | Not the core. Overlaps in primitives, differs in shape — see below |
| 3. Playwright MCP (`npx playwright mcp` / `@playwright/mcp`) | MCP server exposing browser tools to agents | Optional, detected and validated — never required |
| 4. Hybrid | Core on the Node API, plus MCP awareness | **Chosen overall** |

### Why the Node API is the core

AgentView's promise is that inspection *works even when the agent's browser integration does not*. A core that depends on an MCP connection inherits exactly the failure mode the product exists to diagnose: if MCP is down, AgentView could not tell you *why*. Owning the browser lifecycle directly means AgentView can always produce a report — including reports whose subject is a broken browser setup.

`playwright-core` specifically, not `playwright`:

- `playwright-core` has **zero dependencies** and does not download browsers on install, so `npx agentview` stays small and never triggers a surprise ~150 MB download.
- It reads the same shared browser cache (`~/Library/Caches/ms-playwright` on macOS), so it reuses whatever the developer already installed for their own tests.
- It still ships the full CLI (`install`, `screenshot`, `mcp`, `cli`), which is what `agentview doctor` shells out to for browser installation.

### Honest positioning against `npx playwright cli`

Playwright 1.62 absorbed the MCP server into core and now ships a first-party agent CLI **and its own Claude-compatible Agent Skill**. AgentView must not claim to be the first or only way for an agent to drive a browser — it isn't, and the README says so.

The distinction is shape, not capability:

- `playwright cli` is **interactive and session-oriented**: open a session, act, observe, act again, close. The agent stays in the loop and decides what to look at.
- `agentview inspect` is **one-shot and deterministic**: boot or find the server, navigate, capture a fixed evidence bundle, classify the failure by layer, write durable artifacts, exit with a meaningful status code. No agent judgement is required for it to produce a correct diagnosis.

The parts AgentView adds that a browser-driving CLI deliberately does not: dev-server lifecycle and port discovery, port-ownership verification, layered failure classification, conservative blank-render assessment, redaction, artifact bundles, and hook-driven automatic verification. Those are orchestration and diagnosis concerns, not browser-automation concerns.

## Verified findings that shaped the implementation

These were confirmed by running code against `playwright-core@1.62.1`, not just read from docs. Each changed the design.

1. **`requestfailed` does not fire for HTTP 4xx/5xx.** It fires only for transport-level failures (DNS, connection refused, abort). Listening to it alone would miss every 404 and 500 — the most common real failures. AgentView therefore listens to **both** `requestfailed` and `response` (status ≥ 400). — `src/inspect/collect.ts`
2. **Chromium mirrors failed responses onto the console channel**, so a single 404 would be counted twice (once as a console error, once as a network entry). AgentView filters the mirrored console message and keeps the richer network record. — `src/inspect/collect.ts`
3. **`executablePath()` is not an install check.** It reports where Playwright *expects* a binary regardless of whether one exists, and it ignores the `channel` option. AgentView treats it as a diagnostic hint and uses an actual launch attempt as the authoritative check. — `src/browser/driver.ts`
4. **Default headless uses the reduced "headless shell" binary, not Chromium.** Since rendering fidelity is the entire premise of this tool, AgentView launches with `channel: 'chromium'` ("new headless" — the real Chromium build). — `src/browser/driver.ts`
5. **`page.accessibility` and `_snapshotForAI` do not exist in 1.62.** The public, stable API is `ariaSnapshot()`; AgentView uses `mode: 'ai'`, which filters noise, includes iframes, and does not wait for matching elements. — `src/inspect/collect.ts`
6. **`networkidle` is explicitly DISCOURAGED in the official docs.** AgentView instead uses `waitUntil: 'load'`, then a bounded quiet-period wait, then two animation frames. — `settle()` in `src/inspect/collect.ts`
7. **iPhone device profiles declare `defaultBrowserType: 'webkit'`** and are not faithful iOS emulation under Chromium. AgentView's mobile pass uses the Chromium-native **Pixel 7** profile in its own context, so `pointer: coarse` / `hover: none` media queries actually match. — `src/inspect/collect.ts`

## Port-ownership verification (discovered by dogfooding)

The first real end-to-end run exposed a failure the original design would have gotten wrong. A fixture dev server logged `http://localhost:4599` while actually listening on 4611. AgentView parsed the advertised URL, probed it, got HTTP 200 from an **unrelated application already running on that port**, and reported `HEALTHY_RENDER` — with the wrong app's page title in the report.

A reachable URL is not proof it is *your* server. When AgentView starts the dev server itself, it now resolves which PID listens on the candidate port (`lsof`) and verifies that process descends from the process tree it spawned. Foreign owners are rejected and inspection continues waiting; if only a foreign owner is ever reachable, the run ends as `SERVER_PORT_CONFLICT` naming the offending process. Ownership checking is best-effort: where it cannot be determined it reports `unknown` and never blocks. Reuse of a *user-declared* URL/port is still intentional and allowed. — `src/server/ownership.ts`

## Module boundaries

```
src/
  cli/           main.ts — argument parsing only, no logic
  commands/      one file per command; presentation + orchestration
  config/        schema.ts (zod) + config.ts (load/save/merge)
  project/       project root, package manager, dev-script discovery
  frameworks/    FrameworkAdapter interface + next/vite/generic adapters
  server/        lifecycle.ts (spawn/reuse/readiness), probe.ts, ownership.ts
  browser/       driver.ts — install detection + Chromium launch
  inspect/       collect.ts (evidence gathering), run.ts (pipeline)
  diagnose/      verdict.ts (model), blank.ts (heuristic), diagnose.ts (mapping)
  artifacts/     report.ts (schema + markdown), write.ts (filesystem)
  security/      redact.ts
  integrations/  claude.ts (status), claude-install.ts (skill + hooks)
```

Dependency direction is strictly one-way: `commands → inspect/diagnose → server/browser → project/config`. Nothing below `commands/` prints to stdout, so every layer is testable without capturing console output.

### Adding a framework

Implement `FrameworkAdapter` (detection predicate, dev-script candidates, default port, URL log patterns, error-overlay selectors, app-root selectors) and add it to the `ADAPTERS` array. No other file changes. Adding Windows/Linux support similarly touches only `server/ownership.ts` and `browser/driver.ts` cache paths.

## The inspection pipeline

```
findProjectRoot            → PROJECT_NOT_RECOGNIZED
detect framework/pm/script → DEV_COMMAND_NOT_FOUND
localhost guard            → (blocks remote URLs unless --allow-remote)
ensureServer               → SERVER_START_FAILED / SERVER_START_TIMEOUT / SERVER_PORT_CONFLICT
  ├ reuse a healthy server at a user-declared URL, or
  └ spawn detached, capture logs, parse URL, probe, verify port ownership
launchChromium             → BROWSER_NOT_INSTALLED / BROWSER_LAUNCH_FAILED
collectRoute               → NAVIGATION_FAILED
  ├ goto(waitUntil:'load') → settle (no networkidle)
  ├ DOM stats, aria snapshot (mode:'ai'), desktop screenshot
  ├ separate Pixel 7 context for the mobile screenshot
  └ console / pageerror / requestfailed / response≥400
diagnoseRoute              → ROUTE_NOT_FOUND · AUTHENTICATION_GATE ·
                             APPLICATION_RUNTIME_FAILURE · LIKELY_BLANK_RENDER ·
                             FAILED_DEPENDENCY_REQUEST · PARTIAL_RENDER ·
                             HEALTHY_RENDER · INDETERMINATE
writeReport + updateLatest
```

A report is written for **every** outcome, including the earliest failures, so an agent always has something to read. Cleanup in a `finally` block stops only servers AgentView started.

## Diagnosis model

`verdict.ts` owns three mappings used everywhere: verdict → layer, verdict → domain (`setup` / `application` / `healthy` / `unknown`), and verdict → exit code. The `domain` field is the single most useful thing in the report for an agent: it says whether to fix the environment or the application, which is exactly the confusion the product exists to remove.

Exit codes: `0` healthy · `1` application problem · `2` setup/environment problem · `3` indeterminate · `4` CLI usage error.

## Blank-render heuristic

Multi-signal with confidence, deliberately biased against crying blank (see PRODUCT_SPEC §Blank-page detection). A fast path exits early with `likelyBlank: false` when the page has real text, real elements, and something interactive. A uniform screenshot counts as *strong* evidence only when the DOM is also empty — on its own it is weak, because plenty of healthy pages are mostly background colour. Pixel sampling covers only the first screenful; below the fold is mostly background on long pages and would drown out real content. Two strong signals (or one strong plus two weak) are required before claiming a blank page; anything less is reported as `uncertain` with its reasons listed.

## Claude Code integration

- **Skill** at `.claude/skills/agentview/SKILL.md`, auto-discovered by description matching. Frontmatter uses only documented fields (`name`, `description`).
- **Hooks** written to `.claude/settings.local.json` by **default** — it is personal and git-ignored, so installing AgentView never imposes a browser-launching hook on everyone who clones the repo. `--shared` opts into the committed `settings.json`.
  - `PostToolUse` (matcher `Write|Edit|MultiEdit|NotebookEdit`) marks frontend verification stale. Cheap; never launches a browser; ignores non-frontend paths.
  - `Stop` runs at most one inspection when state is stale.
- **Loop safety**, three independent mechanisms: no stale marker → immediate exit; `stop_hook_active` → never block twice in a turn; a lock file prevents concurrent inspections. The stale marker is cleared *before* the run so edits made during it correctly re-mark.
- Existing settings are parsed and merged, never overwritten; a backup is written before the first edit; AgentView's own entries are tagged `agentview-hook` so they can be found and removed cleanly.

## Deliberate non-goals for v0.1

No hosted dashboard, account system, telemetry, or AI dependency. Every check is deterministic and works offline without an API key.
