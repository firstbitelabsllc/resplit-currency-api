# Taming Xcode 26 Build Contention Across an AI-Agent Fleet

*A field report on what breaks when many automated coding agents build one Xcode
workspace at once — and the three-layer fix that made it stop.*

> Vendor-neutral writeup. Nothing here is specific to one app; if you run more than
> one `xcodebuild` against a single workspace on a single Mac — agents, CI runners,
> cron deploy-watchers, or just an over-eager build script — this is for you.

---

## The symptom

We run a small fleet of AI coding agents (Claude Code, Codex CLI) plus a couple of
cron jobs (a deploy-watcher that ships TestFlight builds, a review bot) against a
**single iOS Xcode workspace** on a **single developer Mac**. Each agent thinks it is
alone. Each kicks off `xcodebuild` (directly, or via `tuist xcodebuild`, or via an MCP
build server) whenever it wants to verify a change.

Under load we watched the machine spawn **16 to 68 simultaneous `xcodebuild`
processes**, and then watched them **mutually kill each other**:

```
xcodebuild: error: SIGTERM
```

Builds that should take 90 seconds would hang for minutes, get SIGTERM'd partway
through, and leave behind stale lock files. A naive "just retry" made it strictly
worse — the retry joined the pile-up. We saw cascades reach ~25 live `xcodebuild`
processes before anyone intervened.

The instinct — "isolate each agent's `-derivedDataPath` so they can't collide" — **did
not fix it.** That was the most important and most counterintuitive finding.

---

## The root cause

On Xcode 26, every `xcodebuild` invocation on a machine is brokered by a **single
per-user shared build service**, `SWBBuildService` (the Swift Build service that
replaced the older `XCBBuildService`). It is a per-*user* daemon, not a per-build one.

When two or more `xcodebuild` processes drive that shared service against the same
workspace concurrently, they **race a workspace/build-service-level lock and deadlock**.
Xcode's own resolution to the deadlock is to SIGTERM the contending builds — which is
exactly the cascade we saw.

The critical consequence:

- **`-derivedDataPath` isolation does not help.** DerivedData isolation prevents one
  class of collision (two builds clobbering each other's `build.db`), but the lock that
  produces the SIGTERM pile-up lives at the **workspace / shared-build-service** level,
  *above* DerivedData. You can give every agent a pristine private DerivedData directory
  and still deadlock the shared `SWBBuildService`.

- **Detection is not prevention.** The first-generation mitigation was a pre-flight
  check — `ps aux | grep xcodebuild` before starting, and `killall` to clear a jam. But
  by the time a `grep` sees the pile-up, it has already formed, and `killall` in any
  loop or auto-respawning context becomes a self-inflicted denial of service (more on
  that below). You cannot `grep`-and-`killall` your way out of a structural race.

So the problem statement, in one line:

> **Many `xcodebuild` processes funneling through one per-user `SWBBuildService`
> deadlock when they race it. The fix is not isolation — it is to stop them racing.**

---

## The fix: three stacked layers

The mental model is three verbs: **serialize, cheapen, cover the gap.**

1. **Serialize** the builds so only one drives `SWBBuildService` at a time. Contention
   becomes structurally impossible instead of merely watched-for.
2. **Cheapen** each build with a compilation cache, so the serialized queue *drains
   fast* — a queue only helps if the thing being queued is quick.
3. **Cover** the path that bypasses your shell wrapper. Agents that build through an MCP
   server never touch your `PATH`, so the serializer has to be enforced there too.

### Layer 1 — Serialize with a held file lock (`xcb-lock`)

The core fix is a tiny wrapper that holds a **per-user advisory file lock across the
build's entire lifetime**, so competing builds **block (queue)** instead of racing.

macOS ships no `flock(1)` binary, so this is ~30 lines of Python around
`fcntl.flock`. Three details make or break it:

- **Hold the lock across `exec`.** The wrapper takes the lock, then `execvp`s the real
  build command. For the lock to survive into the build process, you must **clear
  `FD_CLOEXEC`** on the lock file descriptor first — otherwise the OS closes the fd (and
  releases the lock) the instant you hand off, and you've serialized nothing. This is the
  single most common way to get this wrong.
- **Blocking exclusive lock = a FIFO-ish queue.** `LOCK_EX` without `LOCK_NB` means each
  waiter sleeps until the holder finishes, then proceeds. No spin, no polling.
- **Bounded wait, and time-out to a *retryable* exit code — never to `killall`.** Cap the
  wait with `SIGALRM`; on timeout exit `75` (`EX_TEMPFAIL`) so the caller retries on its
  next cycle. Timing out must never escalate to killing other builds.

```python
#!/usr/bin/env python3
# xcb-lock — serialize xcodebuild/tuist builds behind one per-user blocking lock.
import sys, os, fcntl, signal, time

lock_path = os.environ.get(
    "XCB_LOCK_PATH",
    os.path.join(os.environ.get("TMPDIR", "/tmp"), f"xcodebuild-{os.getuid()}.lock"),
)
wait_s = int(os.environ.get("XCB_LOCK_WAIT", "2400"))  # 40 min cap

fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
# Clear FD_CLOEXEC so the lock survives execvp into the build — the load-bearing line.
fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.fcntl(fd, fcntl.F_GETFD) & ~fcntl.FD_CLOEXEC)

def _timeout(_sig, _frm):
    sys.stderr.write(f"xcb-lock: TIMED OUT after {wait_s}s — another build holds the lock\n")
    os._exit(75)  # EX_TEMPFAIL — caller retries next cycle, NOT killall
signal.signal(signal.SIGALRM, _timeout)
signal.alarm(wait_s)

fcntl.flock(fd, fcntl.LOCK_EX)   # blocks here until it's our turn
signal.alarm(0)

os.execvp(sys.argv[1], sys.argv[1:])  # run the build, holding the lock for its lifetime
```

Usage is a transparent prefix — anything build-like goes behind it:

```bash
xcb-lock tuist xcodebuild build -scheme 'MyApp Debug' -derivedDataPath /tmp/dd-agent-7
xcb-lock tuist xcodebuild test  -scheme 'MyApp Debug' -only-testing:MyAppTests
```

This **supersedes the `ps aux` pre-check + `killall` reflex** entirely. There is no
longer a "scan for running builds before you start" step — you take the lock and queue.

A thin semantic alias (`xbq`, "Xcode build queue") gives cron, Fastlane, and hook
callers one stable command surface and an allowlist of build-like commands
(`xcodebuild`, `tuist build/test/xcodebuild`, `fastlane`, `gym`, `scan`) so non-build
commands pass through unlocked:

```bash
xbq -- tuist xcodebuild build -scheme 'MyApp Debug' -derivedDataPath "$DD_PATH"
```

Note: pure **project generation** (e.g. `tuist generate`) needs **no lock** — it does
not drive `SWBBuildService`. Only compile/test/archive work has to queue.

### Layer 2 — Cheapen each build with a CAS compilation cache

Serializing only helps if each build is fast; otherwise the queue stalls and you've
traded a pile-up for a traffic jam. Xcode 26 introduced a **content-addressable storage
(CAS) compilation cache** — compiled modules are keyed by a hash of their inputs, so an
identical compile is a **cache hit (a download), not a recompile**.

Crucially, the cache daemon is **local and shared across every process on the machine**.
So once one agent compiles a module on the current commit, *every other agent's*
serialized build of that same module is a near-instant hit. The queue drains fast.

With a project-generation tool this is a one-time setup plus a config flag. The setup
brings up the local cache daemon:

```bash
tuist setup cache      # start the local CAS compilation-cache daemon
```

and the project opts in (here, in `Tuist.swift`):

```swift
let tuist = Tuist(
  project: .tuist(
    generationOptions: .options(
      enableCaching: true   // Xcode 26 CAS compilation cache
    )
  )
)
```

Warm it once on your trunk branch *before* fanning out agents, and the first serialized
build pays the compile cost while the rest ride the cache. (If you have a remote/cloud
cache token, the same cache can be shared cross-machine, but the local daemon alone is
what kills the on-machine contention.)

If you don't use a generation tool, the underlying lever is the same: feed `xcodebuild`
a stable compilation cache so repeated builds across agents don't redo identical work.

### Layer 3 — Cover the MCP build path

Here's the gap that bites you after Layers 1 and 2 are in place: **many agents don't
build through your shell at all.** They call an **MCP build server** (e.g.
XcodeBuildMCP) — an out-of-process tool the agent invokes directly. That path never
sources your `PATH`, never sees the `xcb-lock`/`xbq` prefix, and so it sails straight
past the serializer and back into the pile-up.

You have to enforce the queue on that path too. Two complementary controls:

**(a) A `PreToolUse` hook that blocks build/test MCP tools.** Claude Code (and similar
agent runtimes) can run a hook before every tool call; exiting non-zero blocks the call.
A ~20-line script reads the tool name from the hook payload and **blocks only the
compile/test tools** (`build_sim`, `build_run_sim`, `build_device`, `test_sim`,
`test_macos`, `build_macos`, …) while **allowing the proof tools** (`screenshot`,
`snapshot_ui`, `tap`, `launch`, `install`, `logs`) — those don't drive the build service
and you still want them for UI verification.

```python
#!/usr/bin/env python3
# PreToolUse guard: block MCP *build/test* tools; allow simulator proof tools.
import json, sys

BLOCKED = ("build_sim", "build_run_sim", "build_device", "build_run_device",
           "test_sim", "test_device", "test_macos", "build_macos")

payload   = json.loads(sys.stdin.read() or "{}")
tool_name = (payload.get("tool_name") or payload.get("name") or "").lower()

if any(frag in tool_name for frag in BLOCKED):
    sys.stderr.write(
        "MCP build/test tools are blocked: route compiles through the queue, e.g.\n"
        "  xbq -- tuist xcodebuild build -scheme 'MyApp Debug' -derivedDataPath \"$DD_PATH\"\n"
        "Then use MCP for install/launch/screenshot/snapshot/log UI proof.\n"
    )
    sys.exit(2)   # non-zero blocks the tool call
sys.exit(0)
```

The hook redirects the agent to run the actual compile through `xbq` (Layer 1) and then
come back to the MCP server for install/launch/screenshot/UI proof.

**(b) A queue-aware wrapper for the MCP server itself.** If you must let the MCP server
do builds, front its CLI with a shim that routes build-like subcommands
(`build`, `test`, `archive`, `clean`) through `xbq` and lets passthrough commands
(simulator/discovery/UI) run direct. The same shim launches the MCP server with a
**build-incapable workflow set by default** (simulator-management, project-discovery,
session-management, ui-automation, xcode-ide) so the agent *can't* build through MCP
unless explicitly opted in — builds go to the queue, proof stays on MCP.

---

## Bonus: the RCA technique — find the runaway by parent PID

When a pile-up *is* on the floor and you need to know *who* spawned it (which agent,
which cron), don't eyeball a flat `ps` list of 40 near-identical `xcodebuild` lines.
**Group the offenders by parent PID** — the runaway source is whichever parent owns the
biggest cluster:

```bash
# Count live xcodebuild processes grouped by their parent PID (PPID),
# busiest parent last. That PPID is your runaway spawner.
ps -axo ppid,pid,command | awk '/[x]codebuild/ {print $1}' \
  | sort | uniq -c | sort -n

# Then identify the parent itself (the agent / cron / wrapper):
ps -p <PPID> -o pid,command
```

One parent owning 20 of 25 `xcodebuild` children means *that* process is blind-retrying
or fan-spawning — fix it there, not by killing leaves.

### The one rule about `killall`

`killall xcodebuild` / `killall SWBBuildService` is **not** a contention tool. In an
auto-respawning agent swarm it is an **infinite kill loop**: every new session kills
every other session's build, forever. Even single-lane, it nukes every agent's
in-flight work.

- **Never** put `killall` in a setup script, agent preamble, or any loop.
- The **one** sanctioned use is clearing an *existing* SIGTERM cascade **once**, before a
  **single** retry: `killall xcodebuild SWBBuildService` → retry one time. Never
  blind-retry without clearing first — that is precisely how a 25-process pile-up forms.

With Layers 1–3 in place you should essentially never reach for `killall` again, because
the cascade can't form in the first place.

---

## Putting it together

| Layer | Mechanism | What it buys you |
|---|---|---|
| **1 — Serialize** | `xcb-lock` / `xbq`: per-user `fcntl.flock` held across `exec` | Only one build drives `SWBBuildService` at a time → the deadlock race is structurally impossible. |
| **2 — Cheapen** | Xcode 26 CAS compilation cache (`tuist setup cache` + `enableCaching`) | Each serialized build is a near-instant cache hit shared across agents → the queue drains fast. |
| **3 — Cover the MCP gap** | `PreToolUse` hook + queue-aware MCP shim | Agents that build through an MCP server are routed back through the queue instead of escaping it. |
| **RCA** | Group `xcodebuild` by PPID; `killall` only as a one-shot cascade-clear | Find and fix the runaway *spawner*; stop the self-inflicted kill loop. |

The headline lesson, if you take one thing away:

> **Isolating `-derivedDataPath` does not stop Xcode 26 multi-build contention — the
> deadlock is at the shared `SWBBuildService` level. Serialize the builds behind one
> held lock, make each build cheap with the CAS cache, and don't forget the MCP path
> that bypasses your shell.**

---

## Sources & prior art

- **Xcode 26 / `SWBBuildService`** — the per-user shared Swift Build service that brokers
  every `xcodebuild`; the workspace/build-service-level lock is the thing that deadlocks
  under parallel races (above DerivedData).
- **Cross-process build serialization with a held `flock`** — confirmed against several
  independent implementations in the agent/MCP-Xcode tooling space (2026): cmux PR #2981
  (the `FD_CLOEXEC`-across-`exec` gotcha), `toba/xc-mcp`, and `meshmac`. The shared
  insight across all of them: a per-user blocking lock held across the build's lifetime is
  what turns the pile-up from "monitored" into "impossible."
- **Tuist Xcode 26 compilation cache** — `tuist setup cache` + `enableCaching` for the
  local CAS daemon shared across processes on one machine.
- **XcodeBuildMCP** — the MCP build server whose tool calls bypass shell wrappers, which
  is why Layer 3 (PreToolUse hook + MCP shim) exists.
