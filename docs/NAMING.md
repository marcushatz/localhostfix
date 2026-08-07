# Naming

**Status: resolved.** The project is **LocalhostFix**. It was renamed from the
working name "AgentView" on 2026-08-07, before any public release.

| Surface | Name |
|---|---|
| Product / display name | **LocalhostFix** |
| npm package | `localhostfix` |
| CLI binary | `localhostfix` |
| GitHub repository | `localhostfix` |

## Availability, verified 2026-08-07

Every check below was run from the terminal against the authoritative source,
not inferred from search results.

| Surface | Result | Evidence |
|---|---|---|
| npm `localhostfix` | **Available** | `npm view localhostfix` → E404; `curl https://registry.npmjs.org/localhostfix` → HTTP 404; `npm search localhostfix` → "No matches found" |
| npm `localhostfix-cli` | Available | E404 |
| npm `@localhostfix/cli` | Available | E404 (scope deliberately **not** registered) |
| GitHub org/user `localhostfix` | **Available** | `api.github.com/users/localhostfix` → HTTP 404 |
| GitHub repos named localhostfix | **None exist** | Repo search `total_count: 0`; `localhostfix in:name` → `total_count: 0` |
| `localhostfix.com` | Available | RDAP 404, with `google.com` → 200 as a control |
| `localhostfix.dev` | Available | RDAP 404 via rdap.org, with `google.dev` → 200 as a control |
| `localhostfix.io` | Available | RDAP 404 |

Web searches for the exact string "LocalhostFix" as a developer tool, CLI, or
npm package returned **no product using this name**. Results were generic
localhost tooling (ngrok, localhost.run, `https-localhost`, `is-localhost-ip`)
and articles that happen to contain the words "localhost" and "fix" — none is a
naming conflict.

No obvious conflicting software brand surfaced. **This is not a trademark
clearance opinion**; see the manual verification list below.

## Why the previous name was abandoned

The working name "AgentView" was researched on the same day and found
unusable. The facts below concern **other people's projects** and are recorded
so the decision is not revisited:

1. The npm package `agentview` is taken (v0.1.13, maintainer `r00dy`) and
   `npm view agentview bin` returns `{ agentview: 'dist/bin/agentview.js' }` —
   a direct CLI binary collision, not merely a package-name collision.
2. The npm scope `@agentview` is owned by that same author (`@agentview/studio`
   resolves), so the `@agentview/cli` placeholder could never have been
   published.
3. `github.com/agentview` is taken by a session viewer for conversational
   agents (40 stars).
4. **AgentsView** — one letter away, ~3K stars, promoted at agentsview.io —
   indexes coding-agent sessions for Claude Code, Codex, Cursor and others.
   Same audience, same category.

LocalhostFix is clean on every surface where AgentView was blocked, and it
describes what the tool actually does.

## Still requires manual human verification before release

These could not be completed from the terminal and are the user's to do:

1. **Trademark search.** USPTO TESS, uspto.report, and Justia all block
   automated access. Run "LOCALHOSTFIX" through
   [tmsearch.uspto.gov](https://tmsearch.uspto.gov/) manually, plus EUIPO if the
   EU matters. Risk is low for a non-commercial OSS developer tool, but this is
   not legal advice.
2. **Domain purchase, if wanted.** `localhostfix.dev` and `localhostfix.com`
   both tested available, each against a working control domain. Availability
   changes by the minute — confirm at the registrar. **A domain is not required
   for this open-source release.**
3. **Social handles** (X, Discord, Reddit, Bluesky) — not checked.
4. **npm publish claims the name.** Publishing `localhostfix` is what actually
   reserves it; until then someone else can take it. Nothing has been
   registered or published by this project.
