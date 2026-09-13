# Lattice CLI

`lattice` is the terminal client for the same runtime and SQLite event store used by the desktop app.
A thread started in a terminal is visible in the GUI, and a thread started in the GUI can be followed
from a terminal.

## Install and develop

The packaged macOS app carries the Node-ABI CLI bundle. From a checkout, build and run it with:

```bash
pnpm build:cli
node bin/lattice --version
pnpm cli --help
```

To install a command-line shim in `~/.local/bin`:

```bash
lattice install
```

Use `--dir` to choose another directory and `--alias` to choose the short command. Make sure the
chosen directory is on `PATH`.

## Starting a session

```bash
lattice
lattice "fix the flaky test"
git diff | lattice -p "review this diff" --json
lattice -p --resume THREAD_OR_TITLE "continue the fix" --preset workspace
```

The CLI finds the nearest Git root (or an `AGENTS.md`/`CLAUDE.md` boundary), resolves or creates a
workspace, and stores the terminal's current directory on the thread. Relative file and shell paths
therefore use the directory where the session started, while remaining contained by the workspace
roots.

Useful session flags:

```text
--model ID                 choose a model
--mode plan|act|review     choose the thread mode
--preset manual|workspace|full
--continue                 use the newest non-archived thread
--resume [ID|title]        resume an existing thread
--add-dir PATH             add an approved root (use --yes in a pipe)
--goal TEXT                set the thread goal
--instructions TEXT|@FILE  set standing instructions
-i, --image PATH           attach an image; repeatable
```

## Transports and single-writer behavior

Transport selection is:

1. `--remote` or `LATTICE_REMOTE`: authenticated HTTP + WebSocket bridge.
2. A live runtime in the selected data directory: local `control.sock` attachment.
3. An embedded headless runtime: the CLI boots the runtime in-process.

The data directory contains `runtime.lock`, `runtime.json`, and `control.sock`. Only one runtime may
own a data directory. A second CLI attaches when possible; if the lock is held but the socket is not
reachable, it exits with the owning PID and the `--remote`/quit recovery paths instead of opening a
second SQLite runtime.

Select a data directory with `--data-dir` or `LATTICE_DATA_DIR`. On macOS the default is
`~/Library/Application Support/Lattice`; other platforms use `~/.lattice`.

For a long-lived local runtime:

```bash
lattice --data-dir /path/to/state serve
lattice --data-dir /path/to/state threads list --json
```

`lattice doctor --json` reports the runtime metadata, whether its control socket answers, the
protocol version, and native module availability.

## Print mode and output contracts

Print mode never opens a composer or waits for an approval. A tool approval is denied and reported
with exit code 5; `--ask-answer` supplies a canned answer for `ask_user`.

```bash
lattice -p "summarize the failing tests"
lattice -p "review the diff" --output-format json
lattice -p "run the checks" --output-format stream-json --max-turns 6 --timeout 10m
```

`json` emits one result object. `stream-json` emits newline-delimited envelopes with protocol `1`,
the persisted `RunEvent` unchanged, approval/ask decisions, and a final result envelope. Consumers
should ignore unknown envelope types so additive protocol changes remain forward compatible.

Exit codes are stable: `0` success, `1` generic run or command failure, `2` usage error, `3`
transport/auth/protocol failure, `4` cancellation or timeout, `5` non-interactive tool denial, and
`130` conventional prompt-time SIGINT.

## Commands

```text
lattice threads list|show|new|rm|clear|fork|compact|archive|unarchive|pin|unpin|search|title
lattice send THREAD TEXT [--steer|--queue] [--image PATH]
lattice attach THREAD_OR_TITLE [--follow] [--since N]
lattice stop THREAD       lattice retry THREAD [--mode auto|resume|restart]
lattice models [--refresh|--health]       lattice providers [--check ID]
lattice mcp list|add|remove               lattice memory list|search|add|rm|sync
lattice todos list|add|done|rm|clear       lattice jobs list|stop
lattice usage [--json]                    lattice sessions [--activity] [--watch]
lattice message THREAD TEXT                lattice inbox [THREAD] [--read MESSAGE]
lattice config get|set|list               lattice config profile list|set|rm
lattice completion bash|zsh|fish
lattice doctor                            lattice install
lattice channels status|serve|setup|pair|owners|notify|install-agent|uninstall-agent
```

`lattice channels` runs the text gateway: Telegram, iMessage (Photon), and phone calls (Vapi)
into one assistant thread. See [channels.md](channels.md).

List and inspection commands support `--json`, returning the same shapes exposed by `LatticeApi`.
`mcp add` accepts a JSON object or `--config @file`; secrets are redacted by the shared bridge
dispatch path before they are returned.

## Permissions and environment

Interactive sessions default to `act` + `workspace`. Piped/print sessions default to `plan` +
`manual`. Widen a non-interactive run explicitly with `--preset workspace` or `--preset full`.
`--yolo` is an alias for `--preset full` and requires `--yes` when stdin is not a TTY.

Repeatable rules are seeded at thread scope before the turn:

```bash
lattice -p "run the formatter" --preset workspace \
  --allow-tool 'shell:pnpm *' --deny-tool 'fs_delete:dist/**'
```

Flags take precedence over environment variables, then the named profile, then application
settings. Relevant variables include `LATTICE_DATA_DIR`, `LATTICE_REMOTE`, `LATTICE_TOKEN`,
`LATTICE_PASSWORD`, `LATTICE_PROFILE`, `LATTICE_MODEL`, `LATTICE_MODE`, `LATTICE_PRESET`,
`NO_COLOR`, and `FORCE_COLOR`. Use `--password-stdin` for scripted remote provisioning; passwords
are not accepted as a flag or echoed.

## Troubleshooting

- `protocol mismatch`: update the CLI or the running Lattice app so both speak the same local
  control protocol.
- `lock is held but the socket is unreachable`: quit the reported PID or use `--remote`; do not
  delete the lock while that process is alive.
- native module unavailable: run `lattice doctor`; a checkout may need
  `npx electron-rebuild -f -o better-sqlite3,node-pty` for the desktop runtime and a Node-ABI install
  for an embedded CLI.
- `NO_COLOR=1` or `TERM=dumb` disables styling and live cursor redraws. `--plain` keeps every
  interactive update in scrollback for screen readers and log capture.
