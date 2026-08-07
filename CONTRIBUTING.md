# Contributing to LocalhostFix

Thanks for considering a contribution. LocalhostFix is a small, deliberately focused tool; the bar for changes is honesty and evidence rather than volume.

## Principles

1. **Deterministic over clever.** Every core check must work offline, without an API key, and give the same answer twice.
2. **Never claim more than the evidence supports.** If a signal is ambiguous, report `uncertain` with reasons. Confident wrong answers are the failure mode this tool exists to prevent.
3. **Never touch what you did not create.** No killing foreign processes, no rewriting user source, no clobbering user config.
4. **Test the broken path.** A feature that only has a happy-path test is not finished.

## Setup

```bash
git clone <repo> && cd localhostfix
npm install
npm run build
npm test
```

Requires Node.js 22+ and a Playwright Chromium build (`npx playwright install chromium`).

## Project layout

```
src/cli/          argument parsing only
src/commands/     one file per command (presentation + orchestration)
src/config/       zod schema, load/save/merge
src/project/      project root, package manager, dev-script discovery
src/frameworks/   FrameworkAdapter interface and adapters
src/server/       dev-server lifecycle, probing, port ownership
src/browser/      Chromium install detection and launch
src/inspect/      evidence collection and the pipeline
src/diagnose/     verdict model, blank heuristic, diagnosis
src/artifacts/    report schema, markdown rendering, filesystem writes
src/security/     redaction
src/integrations/ agent integrations (Claude Code today)
```

Dependencies flow one way: `commands → inspect/diagnose → server/browser → project/config`. Nothing below `commands/` writes to stdout, which keeps every layer testable.

## Adding a framework

Implement `FrameworkAdapter` in `src/frameworks/adapter.ts` and add it to `ADAPTERS` (before `genericAdapter`, which is the catch-all):

```ts
export const remixAdapter: FrameworkAdapter = {
  id: 'remix',
  displayName: 'Remix',
  detect: (pkg) => Boolean(pkg.dependencies?.['@remix-run/dev']),
  devScriptCandidates: ['dev'],
  defaultPort: 3000,
  urlPatterns: [/Local:\s+(https?:\/\/\S+)/i],
  errorOverlaySelectors: [],
  appRootSelectors: ['#root'],
  devProcessPatterns: [/remix/i],
};
```

Add detection and URL-parsing cases to `test/unit/discovery.test.ts`. No other file should need changing — if it does, the abstraction is wrong and that is worth discussing in the PR.

## Adding an agent integration

Add a module under `src/integrations/`. It must:

- Write only project-level files, never global configuration.
- Merge into existing config rather than overwriting; back up before the first edit.
- Tag its own entries so they can be found and removed cleanly.
- Refuse to write when the existing file is malformed, and say so.
- Provide loop protection for anything that triggers automatically.

Mirror `test/integration/claude-integration.test.ts`, which covers preservation, idempotency, removal, malformed input, and loop prevention.

## Tests

- **Unit** (`test/unit/`) — pure logic, no browser, no servers. Fast.
- **Integration** (`test/integration/`) — real fixture servers and real Chromium in temp directories.

Fixtures live in `test/fixtures/servers.ts`. Add a handler there rather than inventing a new server shape. No test may depend on an external website, and no test may assume a particular port is free — bind port `0` and read the assigned port.

## Pull requests

- Keep the diff focused; one concern per PR.
- Add or update tests, including a failing-path test.
- Update the docs when behaviour changes. `README.md` must not overstate what the tool does — that is a review blocker, not a nitpick.
- Run `npm run typecheck && npm test` before pushing.

Commit messages follow `type: description` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`).

## Reporting bugs

Include your OS, Node version, framework, the command you ran, and the relevant `report.json`. **Review artifacts for private data before attaching them** — screenshots capture whatever was on screen.

## Security

Do not open a public issue for a vulnerability. See [docs/SECURITY.md](docs/SECURITY.md).
