# Packaging the desktop app

Until now Lattice only ran through `pnpm dev` (`electron-vite dev`). That is fine for development
but it is not an app: it dies with the terminal, it does not appear in Spotlight or the Dock in any
durable way, and — because the remote bridge lives inside the main process — the iOS client loses
its backend the moment you close the terminal.

`pnpm package` produces a real, installable `Lattice.app`.

## Build and install

```bash
pnpm package
cp -R release/mac-arm64/Lattice.app /Applications/
```

Then launch it from Spotlight (⌘-Space → "Lattice") like any other app.

`pnpm package` runs three steps:

1. `node scripts/make-icon.mjs` — generates `build/icon.png` (1024×1024). The icon is *generated*,
   not checked in: a dependency-free renderer draws the 3×3 lattice mark in the UI's violet
   (`--violet`) on the app canvas colour inside a macOS-proportioned squircle, and writes the PNG
   with `node:zlib`. Change the mark by editing the script, not by replacing a binary.
2. `electron-vite build` — bundles main, preload and renderer into `out/`.
3. `electron-builder` — packs `out/` into `release/mac-arm64/Lattice.app` and a DMG.

Output lands in `release/` (git-ignored).

## What the config does, and why

See `electron-builder.yml`; the non-obvious parts:

- **Bundle id is `com.pulsecore.lattice.desktop`,** not `com.pulsecore.lattice`. The SwiftUI iOS
  client already owns the latter. Two different apps claiming one bundle id makes LaunchServices
  pick between them arbitrarily — which is how you end up launching the wrong "Lattice" from
  Spotlight.
- **Product name stays `Lattice`,** which is what matters for data: Electron derives `userData`
  from the product name, so the packaged app reads and writes the same
  `~/Library/Application Support/Lattice` as the dev instance. Installing it does not orphan your
  threads, settings, providers, or the remote-access password.
- **`asarUnpack` covers `better-sqlite3` and `node-pty`.** They `dlopen` `.node` binaries at
  runtime and `dlopen` cannot read inside an asar, so those files must sit on disk in
  `app.asar.unpacked`.
- **`npmRebuild: false`.** Both modules ship Node-API prebuilds that already load under this
  Electron — the dev instance proves it. Rebuilding would replace working binaries with ones built
  against the wrong ABI.
- **`afterPack: scripts/after-pack.mjs` deep ad-hoc signs the bundle.** This is not optional. We
  build unsigned (`identity: null`), so electron-builder skips signing and leaves behind the
  *linker-signed* signature from Electron's own binary — it still reports `Identifier=Electron`, it
  is not bound to our `Info.plist`, and it does not cover the resources we added, so
  `codesign --verify` fails. Every executable on Apple Silicon must carry a valid signature, so
  that bundle is fragile at best. The hook re-signs nested code first, then the bundle, then
  verifies — and fails the build rather than shipping something that will not launch. The app is
  ad-hoc signed and **not notarized**, which is fine for a locally built app (nothing quarantines
  it), but it is not distributable to other machines as-is.

## Don't run both at once

The packaged app and `pnpm dev` use the *same* data directory and the *same* bridge port (8973).
Running both means two SQLite writers and a port collision. Quit the packaged app before
`pnpm dev`, and quit the dev instance before launching the packaged app.

If you have installed the always-on agents (below), also `touch ~/.lattice-keeper-pause` first —
otherwise the keeper relaunches the packaged app the moment you quit it, straight into the dev
instance's port. Delete the file when you are done.

## The remote bridge

The iOS client (`~/lattice-ios`) reaches this app over the bridge described in
`src/shared/net-protocol.md`. The bridge only starts when **both** conditions in `syncBridge()`
(`src/main/ipc.ts`) hold: remote access is enabled *and* a password is set. Either one missing and
the bridge is silently stopped — the phone then sees connection failures and the Cloudflare tunnel
returns 502, because nothing is listening on `127.0.0.1:8973`.

Configure it in **Settings → Remote access**: set a password, tick *Enable remote access bridge*,
and set the public URL to the hostname the tunnel fronts. Both settings persist, so the packaged
app brings the bridge back up on its own every launch.

## Keeping the phone working unattended

Login Items (**System Settings → General → Login Items**) launches the app once, at login, and
never looks again. That is not enough, because the phone depends on three separate things and the
failure of any one of them surfaces identically — "could not load threads", or Cloudflare's
HTTP 502:

| # | Must hold | Fails when |
|---|-----------|------------|
| 1 | the Mac is awake | the lid closes, or it idles into sleep |
| 2 | `Lattice.app` is running | you quit it, it crashes, or you reboot |
| 3 | `cloudflared` is registered | the tunnel drops and does not re-register |

`scripts/install-always-on.sh` installs two LaunchAgents that cover all three, next to the existing
`com.pulsecore.lattice-tunnel`:

```bash
./scripts/install-always-on.sh
```

- **`com.pulsecore.lattice-bridge`** runs `scripts/lattice-bridge-keeper.sh` under `KeepAlive`. It
  probes the bridge's unauthenticated `GET /health` every 20s — a real liveness check of the main
  process's event loop, not just "is the pid alive" — and relaunches the app when nothing is
  listening. If the app is *running* but the bridge stays dead for six consecutive probes (~2 min),
  it quits and relaunches so `syncBridge()` runs again; that is the wedged-process case. Every 15th
  iteration (~5 min) it also probes the public URL, and if the origin is healthy while Cloudflare
  cannot reach it — invisible from the Mac, and exactly what the phone reports as the tunnel being
  down — it `launchctl kickstart -k`s the tunnel agent.

  The keeper is *copied* to `~/Library/Application Support/Lattice/bin/`, and the agent points at
  the copy, so switching branches cannot leave launchd running a script that no longer exists.
  Re-run the installer after editing it.

- **`com.pulsecore.lattice-awake`** holds `caffeinate -s`, a `PreventSystemSleep` assertion, so the
  Mac keeps serving with the lid shut. macOS honours this assertion **only on AC power** — on
  battery the machine still sleeps on lid close, which is what you want in a bag. To keep serving
  with the lid shut on battery too:

  ```bash
  sudo pmset -a disablesleep 1
  ```

  Undo with `sudo pmset -a disablesleep 0`; check either with `pmset -g | grep -i sleepdisabled`.

Both agents are user agents, so they start at *login*. A reboot that stops at the FileVault or
login window leaves the phone offline until someone logs in — that is the one gap this does not
close, and closing it would mean moving the bridge off the laptop entirely.

### Checking on it

```bash
cat ~/Library/Application\ Support/Lattice/bridge-keeper.status   # one line: state, local, public
tail -f /tmp/lattice-bridge-keeper.log                            # what it did and why
launchctl list | grep pulsecore                                   # all three agents
curl -s https://lattice.pulse-core.com/health                     # the whole path, end to end
```

`state=` reads `ok`, `degraded` (app up, bridge not answering), `down` (app gone), or `paused`.
