# Colima Desktop

A small, Docker Desktop–style GUI for [Colima](https://github.com/abiosoft/colima) on macOS. It shows the Colima engine status, containers, images and volumes; streams container logs; shows live CPU/memory stats and `docker inspect` output; and lets you start, stop, restart and delete things.

It's a thin front end over the `colima` and `docker` CLIs you already have installed. It doesn't bundle a container runtime, open a network port, contact the internet or collect telemetry.

## Requirements

- macOS (Apple Silicon or Intel)
- [Colima](https://github.com/abiosoft/colima) and the Docker CLI, e.g. `brew install colima docker`
- Node.js 20 or later (only needed to build and run from source)

## Getting started

```sh
npm ci
npm start        # launch the app
npm test         # property-based, chaos and posture tests (~20s)
npm run test:chaos   # same suites at 10× the iterations (~2 min)
```

## How it works

```
┌──────────────────────── Renderer (sandboxed Chromium) ─────────────────────────┐
│ index.html + renderer.js + lib/format.js                                       │
│  • polls `colima status`, `docker ps/images/volume ls/stats`                   │
│  • renders with escaped HTML only (esc / ansiToHtml / highlightJson)           │
│  • no Node.js, no network, strict CSP                                          │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │ window.cli.run(cmd, args) / window.cli.logs.*   (preload.js)
               ▼  Electron IPC
┌──────────────────────────── Main process (main.js) ────────────────────────────┐
│ 1. sender check   – only our own top-level file:// page may call                │
│ 2. lib/policy.js  – argv must exactly match an allowlisted command shape        │
│ 3. lib/audit.js   – state-changing commands and denials → audit.jsonl           │
│ 4. lib/runner.js  – execFile (no shell), timeout, output cap, never throws      │
│ 5. lib/log-streams.js – one `docker logs -f` per window, killed on close        │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               ▼
          colima / docker CLIs  →  Colima VM  →  containerd/dockerd
```

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window creation, IPC handlers, navigation/permission lockdown |
| `preload.js` | The only bridge into the page. Exposes `window.cli.run` and `window.cli.logs` |
| `index.html` | Markup and styles |
| `renderer.js` | UI state, polling, rendering, log viewer, stats charts |
| `lib/policy.js` | Command allowlist, `docker logs` argument builder, external URL policy, config |
| `lib/runner.js` | Runs an allowlisted CLI call and always settles to `{ ok, stdout, stderr }` |
| `lib/log-streams.js` | Log-stream lifecycle (start, replace, stop, window destroyed) |
| `lib/audit.js` | Append-only JSONL audit trail |
| `lib/format.js` | Pure, untrusted-input-safe parsing and HTML helpers shared with the tests |

### Polling

The engine status and the container, image and volume lists refresh on a timer. Stats are sampled while at least one container is running, and the last 60 samples per container drive the charts. Logs use a single long-lived `docker logs -f --timestamps` process per window. Switching containers replaces it, and closing the window kills it.

## Security model

The renderer displays text that containers control (log lines, names, labels, inspect JSON), so the design assumes the page could be compromised. It then limits what a compromised page could do.

**Electron hardening**
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. The page can't reach Node.js.
- Strict CSP: `default-src 'none'; script-src 'self'`. No inline or remote script, no `eval`, no network access (`connect-src 'none'`).
- Navigation and `<webview>` are blocked. Every attempt to open a new window is denied. Links to published ports open in the default browser only when they are `http(s)://localhost:<port>` or `127.0.0.1:<port>` with no credentials.
- Every permission request (camera, mic, notifications, geolocation…) is denied except clipboard writes for the Copy buttons.
- Single-instance lock.

**Command allowlist** (`lib/policy.js`). The page can't run arbitrary `docker`/`colima` commands. Each call must match one of these exact shapes:

| Read-only | State-changing |
| --- | --- |
| `colima status --json` | `colima start`, `colima stop` |
| `docker ps -a --format {{json .}}` | `docker start\|stop\|restart <ref>` |
| `docker images --format {{json .}}` | `docker rm -f <ref>` |
| `docker volume ls --format {{json .}}` | `docker rmi <ref>` |
| `docker stats --no-stream --format {{json .}}` | `docker volume rm <ref>` |
| `docker inspect <ref>` | |
| `docker logs -f --timestamps --tail N\|--since T -- <ref>` | |

`<ref>` must match `^[A-Za-z0-9][A-Za-z0-9_.\-:/@]{0,254}$`, so it can never start with `-` and be read as a flag. Processes run through `execFile` with no shell. A compromised page therefore can't, for example, `docker run --privileged -v /:/host`, `docker exec`, `docker cp` or `colima ssh`.

**Robustness.** Every CLI call has a timeout (killed with SIGKILL) and a 32 MB output cap. Nothing that comes back from the CLI can throw inside the main process or wedge the UI.

## Enterprise configuration

All settings are environment variables, so you can set them with MDM, a `launchd` plist or a wrapper script.

| Variable | Default | Effect |
| --- | --- | --- |
| `COLIMA_DESKTOP_READONLY` | off | `1`/`true` turns the app into a viewer: every state-changing command is refused by policy in the main process, not just hidden in the UI |
| `COLIMA_DESKTOP_AUDIT` | on | `0`/`false` disables the audit log |
| `COLIMA_DESKTOP_CMD_TIMEOUT_MS` | `120000` | Hard timeout for each CLI call |
| `COLIMA_DESKTOP_PATH` | `/opt/homebrew/bin:/usr/local/bin` | Colon-separated directories prepended to `PATH` to find `colima`/`docker`. Relative entries are ignored. Point it at a managed toolchain location if you don't use Homebrew |

Example: a launchd `EnvironmentVariables` dict, or

```sh
launchctl setenv COLIMA_DESKTOP_READONLY 1
```

### Audit log

State-changing commands (with their result) and every policy denial are appended as JSON lines to:

```
~/Library/Logs/colima-desktop/audit.jsonl
```

```json
{"ts":"2026-10-30T04:30:18.158Z","user":"ckm","event":"exec","cmd":"docker","args":["stop","web"],"ok":true}
{"ts":"2026-10-30T04:30:20.002Z","user":"ckm","event":"denied","cmd":"docker","args":["run","--privileged","alpine"],"reason":"command not allowed"}
```

The file is created with mode `0600`. Read-only polling isn't logged. A failed write never affects the app. Forward the file with your usual log shipper (e.g. Fluent Bit, Splunk UF, Elastic Agent) if you want it centrally.

## Testing

The tests use Node's built-in runner with [fast-check](https://fast-check.dev). They need no Electron, Docker or Colima.

| Suite | What it checks |
| --- | --- |
| `test/policy.property.test.js` | For random argv (biased toward flag/shell injection payloads), a command is allowed **exactly** when it matches an allowlisted shape. No allowed argv ever contains `run`/`exec`/`cp`/`--privileged`/`-v`/…. Refs can't be flags. Read-only mode blocks exactly the mutating commands. Malformed IPC payloads are rejected, never thrown. `docker logs` args always end in `-- <ref>`. Only credential-free localhost URLs can leave the app. Config parsing is total. |
| `test/format.property.test.js` | Arbitrary container output salted with ANSI codes and HTML/XSS payloads produces only balanced `<span class>` tags and preserves visible text exactly. `highlightJson` is safe and lossless for any JSON. Parsers never throw and never produce `NaN`. |
| `test/runner.chaos.test.js` | Fake `docker` binaries that exit non-zero, are missing, hang, flood 40 MB of output, kill themselves with signals, emit invalid UTF-8, or leave an orphaned child holding stdout. A randomised mix of all of these must always settle within timeout + grace with a well-formed result. |
| `test/log-streams.chaos.test.js` | Random interleavings of start/stop/window-destroy, output, exit, `error` events and spawn failures across three windows. Checks that there's no cross-talk between windows, no send to a destroyed window, at most one live stream per window and no leaked processes. |
| `test/posture.test.js` | Static guardrails: sandbox/isolation flags, navigation and permission lockdown, strict CSP with no inline script or handlers, policy on every IPC path, narrow preload bridge. |

Tune the iteration count with `FC_NUM_RUNS` (property tests, default 2000) and `FC_CHAOS_RUNS` (process chaos, default 40). When a property fails, fast-check prints the seed and a shrunk counterexample. Replay it with `fc.assert(..., { seed, path })`.

Bugs these tests found, now fixed and kept as regression assertions:
- The external link check `url.startsWith('http://localhost:')` accepted `http://localhost:@evil.com/`.
- `toBytes('.')` returned `NaN`, which corrupted the memory chart.
- A JSON field shaped like `{"toString": …}` made `String()` throw during rendering.

## Adding a new command

1. Add its exact argv shape to `COMMANDS` in `lib/policy.js`, with `mutates: true` if it changes state.
2. Call it from `renderer.js` via `docker(...)` / `colima(...)`.
3. Run `npm test`. The property tests cover new shapes automatically. Keep shapes narrow: allow a fixed verb plus `<ref>` placeholders, never free-form flags.
