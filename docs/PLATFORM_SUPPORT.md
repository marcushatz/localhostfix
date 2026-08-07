# Platform Support

## What the labels mean

These are used strictly. "It compiles" and "the unit tests pass" are **not** support.

| Label | Meaning |
|---|---|
| **Verified** | Exercised on this OS by the integration suite or by hand, with the result checked |
| **Expected** | Implemented deliberately for this OS, with unit coverage of its parsing logic, but **never run on that OS** |
| **Untested** | Should work in principle; nobody has confirmed it and there is no targeted coverage |
| **Unsupported** | Known not to work; LocalhostFix reports the limitation rather than guessing |

Only macOS is Verified for v0.1.

## Support matrix

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| Project detection (framework, package manager, dev command) | Verified | Expected | Expected |
| Server discovery (finding the project's server on any port) | Verified | Expected | **Unsupported** |
| Process ownership (proving a server belongs to this project) | Verified | Expected | **Unsupported** |
| Browser inspection (Chromium launch, navigation) | Verified | Expected | Untested |
| Screenshots (desktop + mobile) | Verified | Expected | Untested |
| Claude integration (skill + hooks) | Verified | Expected | Expected |
| Watch mode | Verified | Expected | Untested |
| Safe cleanup (stopping only servers LocalhostFix started) | Verified | Expected | Degraded |

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

## Linux — Expected, not Verified

The Linux implementation reads `/proc` directly, so it needs no external binary — better than shelling out to `lsof`, which is frequently absent from containers and minimal images. Where `/proc` is unavailable or answers nothing useful, it falls back to `lsof`/`ps`.

**What has coverage:** the parsers. `parseProcNetTcp` and `parsePpidFromStat` are unit-tested against captured real-world `/proc` output, including the cases that break naive implementations — listening sockets must be distinguished from established connections by state `0A`, and `/proc/<pid>/stat` must be parsed from the last `)` because the `comm` field can contain spaces and parentheses.

**What has not been verified:** that the pieces work together on a live Linux host. Specifically unconfirmed:

- Whether scanning `/proc/*/fd` reliably maps socket inodes to PIDs at scale.
- Behaviour inside containers, where `/proc` may be namespaced and a "port" may belong to a different network namespace entirely.
- Whether the `lsof` fallback triggers correctly when `/proc` is partially restricted (hardened kernels, `hidepid`).

CI runs the discovery suite on Ubuntu with `continue-on-error: true`. That is a signal, not a promise: a green run there is evidence, and this table moves to Verified only when the suite passes on Linux consistently and someone has used it on a real project.

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
