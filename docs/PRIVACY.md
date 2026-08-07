# Privacy

LocalhostFix is a local developer tool. It has **no telemetry, no analytics, no accounts, and no network calls of its own**. Nothing it captures leaves your machine.

## What LocalhostFix collects, and where it goes

Everything is written to `.localhostfix/` inside your project and nowhere else:

| Artifact | Contents |
|---|---|
| `desktop.png`, `mobile.png` | Screenshots of the rendered page |
| `console.json` | Console errors and warnings |
| `network.json` | Failed and error-status requests (URL, method, status, request headers) |
| `page-errors.json` | Uncaught JavaScript errors and stack traces |
| `snapshot.yml` | Accessibility tree of the page |
| `server.log` | Output of the dev server LocalhostFix started |
| `report.md`, `report.json` | The diagnosis and its evidence |

## Screenshots can contain private information

If you inspect a page showing real data — a logged-in dashboard, customer records, an inbox — **the screenshot contains that data**. LocalhostFix cannot redact pixels. Treat `.localhostfix/runs/` as sensitive.

`localhostfix setup` adds `.localhostfix/runs/`, `.localhostfix/latest/`, and `.localhostfix/state/` to `.gitignore` so artifacts are not committed by accident. If you use LocalhostFix without running setup, add those entries yourself.

## Redaction

Redaction is on by default (`redact: true`) and applies to saved network data:

- **Request headers** — `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `x-session-id`, `api-key` are replaced with `[REDACTED]`.
- **Query parameters** — `token`, `access_token`, `refresh_token`, `id_token`, `auth`, `apikey`, `api_key`, `key`, `secret`, `password`, `session`, `sig`, `signature`, `code` are replaced with `[REDACTED]`.
- **Bodies are never stored.** LocalhostFix does not record request or response bodies at all.

Redaction is a pattern list, not a guarantee. A secret in an unusual header or an unusual parameter name will not be caught. Review artifacts before sharing them.

## Localhost only by default

LocalhostFix refuses non-localhost URLs unless you pass `--allow-remote`. Inspecting a remote or production site means screenshotting real data and storing it on disk; do it deliberately or not at all.

## Isolated browser state

Each inspection uses a fresh Playwright browser context. LocalhostFix does not read, reuse, or modify your everyday browser profile, and it does not persist cookies or storage between runs. It cannot sign in to anything, and it will not carry an existing session into an inspection.

## Removing artifacts

```bash
localhostfix clean     # removes runs/, latest/, and state/; keeps config.json
```
