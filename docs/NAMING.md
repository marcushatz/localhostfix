# Naming

**Status: unresolved. This is the one release blocker that needs a human decision.**

Research date: 2026-08-07. Every npm claim below was verified twice — once by a research pass, once independently by re-running the command shown.

## Summary

The working name **AgentView** is not viable for publication. Four independent blockers, any one of which would be awkward; together they are disqualifying:

1. The npm package `agentview` is taken **and ships a CLI binary literally named `agentview`** — a direct command collision, not just a package-name collision.
2. The npm scope `@agentview` is **already claimed by that same author**, so the current placeholder `@agentview/cli` can never be published.
3. `github.com/agentview` is taken by a project in the same category (a session viewer for conversational agents).
4. **AgentsView** — one letter away, ~3K stars, actively promoted at agentsview.io — indexes coding-agent sessions for Claude Code, Codex, Cursor and others. Same audience, same category.

Because the project is unpublished, renaming is free right now and gets permanently more expensive later.

## npm availability

| Name | Status | Evidence |
|---|---|---|
| `agentview` | **Taken** | v0.1.13, maintainer `r00dy`. `npm view agentview bin` → `{ agentview: 'dist/bin/agentview.js' }` |
| `@agentview/cli` | **Unpublishable** | The package path 404s, but `npm view @agentview/studio` returns v0.1.13 (maintainer `r00dy`), so the scope is owned |
| `create-agentview` | Taken | v0.1.13, same owner |
| `agent-view` | Available | `npm view agent-view` → E404 |
| `agentview-cli` | Available | E404 |
| `use-agentview` | Available | E404 |
| `agentviewer` | Available | E404 |
| `agentsight` | Available on npm | E404, but `github.com/agentsight` is taken |
| `viewagent` | Available on npm | E404, but `github.com/viewagent` is taken |
| `agentwindow` | Available | `npm view agentwindow` → E404 |

## Existing products in or near this space

| Product | What it is | Why it matters |
|---|---|---|
| [AgentsView](https://www.agentsview.io/) ([repo](https://github.com/kenn-io/agentsview), ~3K stars) | Local-first Go binary indexing coding-agent sessions into SQLite with a web UI + CLI; supports ~29 agents | **The primary blocker.** One letter from our name, same audience, real mindshare |
| [agentview/agentview](https://github.com/agentview/agentview) (40 stars) | "Session viewer and backend for conversational agents" | Owns the npm name, the npm scope, and the GitHub org |
| [AGENTVIEW](https://www.agentview.net/) | Real-estate CRM, SkyBridge Systems, LLC | Active commercial use of the exact name |
| [agentview.cloud](https://agentview.cloud/) | Contact-centre agent dashboards | Active commercial use of the exact name |
| [chrisrobison/agentview](https://github.com/chrisrobison/agentview) | "A text-grid web renderer for AI agents — see the web without screenshots" | Adjacent thesis; worth reading regardless of naming |

GitHub repo search for "agentview" returns roughly 50 repositories.

## GitHub and domains

| Surface | Status |
|---|---|
| `github.com/agentview` | Taken (org, 1 repo) |
| `github.com/agent-view` | Taken (org, 0 repos — reserved) |
| `github.com/agentviewer` | Available |
| `agentview.com` / `.dev` / `.ai` / `.io` | All registered |

## Trademark signals

**No authoritative search was completed.** USPTO TESS, uspto.report, and Justia all blocked automated access.

What basic search does surface: AGENTVIEW is in active commercial use by SkyBridge Systems, LLC (real-estate CRM) and by agentview.cloud (contact-centre dashboards). Neither displays ™ or ® on its site. Unregistered commercial use still creates common-law rights in the US, though a developer CLI is a different goods class.

This is not legal advice and a human must run the search before any public release.

## Recommendation

Rename the product. The strongest verified-clean candidate is **AgentWindow** — the tool is the window through which a coding agent sees the running app, which is exactly what it does.

| Surface | Status |
|---|---|
| npm `agentwindow` | Verified available |
| npm scope `@agentwindow` | No packages exist (registration still needs manual confirmation) |
| `github.com/agentwindow` | Verified available |
| `agentwindow.dev` | Verified available via RDAP |
| `agentwindow.com` | Taken (registered 2011) |

Concretely: display name **AgentWindow**, npm package `agentwindow`, GitHub repo `agentwindow/agentwindow`, CLI binary `agentwindow` (short alias `awin`).

Verified backups: **`uisight`** (npm, GitHub, and uisight.dev all free — but loses the "agent" association) and **`agentmirror`** (npm, GitHub, and agentmirror.dev all free).

Names to avoid despite npm being free:

- `agentviewer` — still collides phonetically with AgentsView.
- `agentsight` / `viewagent` — GitHub orgs already taken.
- `agentview-cli` — publishable, but shipping under a name whose unprefixed form is someone else's CLI binary invites exactly the confusion the rename is meant to escape.

## If the name is kept anyway

Keeping **AgentView** as the display name while publishing under a different package identifier is possible but weak: the binary would have to be renamed regardless (the `agentview` command is taken), so users would type one name and read another. It also does nothing about the AgentsView collision, which is the real problem.

## Requires manual human verification before release

1. **Trademark search** for the chosen name at [tmsearch.uspto.gov](https://tmsearch.uspto.gov/), plus EUIPO if the EU matters. Automated access was blocked, so this is genuinely unchecked.
2. **npm scope ownership** — the registry API does not expose it. Confirm by logging into npm and attempting org creation.
3. **Domain availability at purchase time.** RDAP was checked with a control domain to validate the method, but availability changes constantly.
4. **Social handles** (X, Discord, Reddit, Bluesky) — not checked for any candidate.
5. **Positioning relative to AgentsView.** Even after renaming, decide deliberately whether to position against or alongside it, since it owns mindshare in "seeing what coding agents do."

Related timing signal: `agentpreview.dev` was registered on 2026-08-03. Names in this space are being taken actively; register the domain and GitHub org promptly once a name is chosen.

## Current state of the repository

`package.json` still declares `@agentview/cli` with `"private": true`. That name **cannot be published** — the scope is owned by someone else. It remains only as an inert placeholder so nothing accidentally publishes under a real name before this decision is made. The rename touches `package.json` (`name`, `bin`), the CLI program name, the skill directory `.claude/skills/agentview/`, the artifact directory `.agentview/`, and the documentation.
