# Platform Support

## What the labels mean

These are used strictly. "It compiles" and "the unit tests pass" are **not** support.

| Label | Meaning |
|---|---|
| **Verified** | Exercised on this OS by the integration suite in CI or by hand, with the result checked |
| **Expected** | Implemented deliberately for this OS, with unit coverage of its logic, but **never exercised end to end on that OS** |
| **Untested** | Should work in principle; nobody has confirmed it and there is no targeted coverage |
| **Unsupported** | Known not to work; LocalhostFix reports the limitation rather than guessing |

**macOS and Linux are Verified for v0.1. Windows is not.**

A row is only Verified where a CI job actually ran that behaviour on that OS.
Passing typecheck, build, and unit tests is explicitly **not** enough — those
run on Windows too, and Windows still cannot verify server identity at all.

## Support matrix

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| Project detection (framework, package manager, dev command) | Verified | **Verified** | Expected |
| Server discovery (finding the project's server on any port) | Verified | **Verified** | **Unsupported** |
| Process ownership (proving a server belongs to this project) | Verified | **Verified** | **Unsupported** |
| Browser inspection (Chromium launch, navigation) | Verified | **Verified** | Untested |
| Screenshots (desktop + mobile) | Verified | **Verified** | Untested |
| Claude integration (skill + hooks) | Verified | **Verified** | Expected |
| Safe cleanup (stopping only servers LocalhostFix started) | Verified | **Verified** | Degraded |
| Watch mode | Verified | Expected | Untested |

### The evidence behind each Linux "Verified"

Every Linux row above is backed by a specific CI job on `ubuntu-latest`, with a
real Chromium install, not by inference from the macOS result:

| Row | Evidence |
|---|---|
| Project detection | `Integration (ubuntu-latest)` — fixture projects are detected and their dev commands run |
| Server discovery, Process ownership | `Server discovery (ubuntu-latest)` — the wrong-project suite spawns real child processes with explicit working directories and asserts they are attributed correctly, including the foreign-project and cwd-`/` cases |
| Browser inspection, Screenshots | `Integration (ubuntu-latest)` — real Chromium launches, and the test asserts `desktop.png` / `mobile.png` exist, exceed 1 kB, and carry a PNG header |
| Claude integration | `Integration (ubuntu-latest)` — 14 tests covering skill install, settings merge, hook runtime, and loop prevention |
| Safe cleanup | `Integration (ubuntu-latest)` — the process-hygiene test polls until a started server's port is released |

**Watch mode remains Expected on Linux.** No integration test drives the file
watcher on any OS; only `isFrontendFile` has unit coverage. It is marked
Verified on macOS because it was exercised by hand, and that was not repeated
on Linux.

## What is actually OS-specific

Almost all of it is one module. `src/platform/` defines a `ProcessInspector` interface with four operations — list listening ports, read process working directories and command lines, resolve a parent PID, and terminate a process tree LocalhostFix started. Everything else in the codebase is portable Node.

Adding a platform means implementing that interface. Nothing else needs to change.

| Implementation | Mechanism |
|---|---|
| `platform/posix.ts` | `lsof` for sockets and working directories, `ps` for command lines and parent PIDs, POSIX process groups for termination |
| `platform/linux.ts` | `/proc` for everything (`/proc/net/tcp`, `/proc/<pid>/fd`, `cwd`, `cmdline`, `stat`), falling back to the posix implementation where `/proc` is unavailable |
| `platform/index.ts` → `unsupportedInspector` | Everything returns empty; ownership is reported as unknown |

## macOS — Verified

The reference platform. The full suite, including the wrong-project regression tests that spawn real child processes with explicit working directories, runs here. Requires `lsof` and `ps`, both present in a stock install.

## Linux — Verified in CI

The Linux implementation reads `/proc` directly, so it needs no external binary — better than shelling out to `lsof`, which is frequently absent from containers and minimal images. Where `/proc` is unavailable or answers nothing useful, it falls back to `lsof`/`ps`.

Both `Integration (ubuntu-latest)` and `Server discovery (ubuntu-latest)` pass
on every push, and the discovery job is enforced rather than advisory, so a
Linux regression fails the build.

**What has coverage:** both the parsers and the end-to-end behaviour.
`parseProcNetTcp` and `parsePpidFromStat` are unit-tested against captured
real-world `/proc` output, including the cases that break naive
implementations — listening sockets must be distinguished from established
connections by state `0A`, and `/proc/<pid>/stat` must be parsed from the last
`)` because the `comm` field can contain spaces and parentheses. On top of
that, the full integration and wrong-project suites run on `ubuntu-latest`.

**What is still unconfirmed on Linux**, and therefore not claimed:

- Behaviour inside containers, where `/proc` may be namespaced and a "port" may
  belong to a different network namespace entirely. GitHub's Ubuntu runner is a
  VM, not a container, so CI does not cover this.
- Whether the `lsof` fallback triggers correctly when `/proc` is partially
  restricted (hardened kernels, `hidepid`). CI has an unrestricted `/proc`, so
  the fallback path is not exercised there.
- Distributions other than the runner image. Nothing in the implementation is
  Ubuntu-specific, but only Ubuntu has been run.

## Windows — Unsupported for server identity

Two things genuinely do not work, and both are load-bearing:

1. **Process inspection.** `lsof` and `/proc` do not exist. Windows needs `netstat -ano`, `Get-NetTCPConnection`, or WMI/CIM, plus a different way to read a process's working directory (which Windows does not expose as readily as POSIX). No approximation is shipped, because a wrong answer here means inspecting the wrong application — the precise failure this tool exists to prevent.
2. **Process-group termination.** POSIX negative-PID signalling has no Windows equivalent; cleanup would need `taskkill /T /F`. The fallback signals only the spawned process, so a dev server's grandchildren could survive.

LocalhostFix does not pretend otherwise on Windows. `unsupportedInspector` returns nothing, `doctor` prints *"Process inspection unavailable on this system"*, and ownership is reported as unknown rather than assumed. The rest of the tool — project detection, launching Chromium, screenshots, reports, Claude integration — is plain Node and Playwright, and should work, but is Untested.

**Windows support is explicitly post-v0.1.** Shipping a fragile approximation would be worse than the honest gap, because the whole value of the tool is that its answers can be trusted.

## Degrading safely

Where ownership cannot be established, LocalhostFix says so and continues without the safety net rather than blocking or guessing:

- `doctor` reports process inspection as unavailable in the Port ownership section.
- Discovery marks `ownershipUnavailable: true` in the result, and reports neither project servers nor foreign servers — unknown is unknown in both directions.
- `inspect` still works when a URL is configured or the framework default is reachable; the report records `ownership: "unknown"` so nothing downstream mistakes it for a verified match.

## Contributing a platform

1. Implement `ProcessInspector` in `src/platform/<os>.ts`.
2. Register it in the `select()` switch in `src/platform/index.ts`.
3. Unit-test the parsing logic against captured real output from that OS.
4. Run `npx vitest run test/integration/wrong-project.test.ts` on that OS — it is the suite that proves server identity actually works.
5. Update this table, and only move a row to **Verified** with evidence.
