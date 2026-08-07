# Security

## Threat model

AgentView is a **local developer tool run by a developer on their own machine against their own development server**. It is not a sandbox, not a security boundary, and not safe to point at untrusted content.

It executes, with your privileges:

1. **Your dev command** (`npm run dev` or whatever is configured) in a shell.
2. **Chromium**, which then loads and executes the JavaScript your page serves.

If either is hostile, AgentView provides no protection. Do not run it inside a repository you do not trust, and do not point it at a URL you do not trust — a page you inspect runs its own code in the browser AgentView launched.

## What AgentView will not do

These are enforced in code, not just policy:

- **Never terminates a process it did not start.** Cleanup signals only the process group AgentView spawned. A conflicting server owned by someone else is reported, never killed.
- **Never modifies application source code.** Automated fixes are limited to AgentView's own configuration and files.
- **Never bypasses authentication.** An auth-gated route is reported as `AUTHENTICATION_GATE`. There is no credential injection, no session replay, no CAPTCHA handling.
- **Never disables SSL validation**, changes firewall or global shell configuration, or installs software via `sudo`.
- **Never downloads browsers without approval.** A missing Chromium is reported with the command to run; AgentView does not run it for you.
- **Never rewrites your global Claude configuration.** Only project-level files, and only additively.
- **Never sends anything anywhere.** No telemetry, no uploads, no external requests.

## Process handling

The dev server is spawned detached, in its own process group, so the whole tree can be signalled on cleanup. Shutdown is `SIGTERM`, a five-second grace period, then `SIGKILL` — applied only to that group.

Because framework default ports collide across projects, AgentView verifies that a server it intends to use actually belongs to the project (by matching the listening process's working directory) and that a server it started is the one answering (by process ancestry). This prevents inspecting — and reporting on — the wrong application. Where `lsof` is unavailable, ownership is reported as `unknown` and AgentView proceeds without the check rather than blocking.

## Command execution

The configured `devCommand` runs through a shell, which is required for `npm run dev`-style commands. It comes from `.agentview/config.json` or your `package.json`. **Treat `.agentview/config.json` as executable content**: a malicious value runs when you invoke AgentView. Review it in repositories you did not create, exactly as you would review a `package.json` script.

## Claude Code integration

`agentview setup --claude` writes:

- `.claude/skills/agentview/SKILL.md` — instructions only, no executable content.
- Hooks in `.claude/settings.local.json` (personal and git-ignored) unless `--shared` is passed. Existing settings are parsed and merged, a backup is written before the first edit, and AgentView's entries are tagged `agentview-hook` for clean removal. Malformed settings are refused rather than overwritten.

The `Stop` hook runs `agentview inspect`, which starts your dev server and a browser. That is a real side effect of finishing a task — which is why it is opt-in, defaults to the personal settings file, and can be disabled with `agentview setup --auto off`.

## Reporting a vulnerability

Open a security advisory on the repository rather than a public issue. Include the version, platform, and a reproduction. There is no bug-bounty programme.
