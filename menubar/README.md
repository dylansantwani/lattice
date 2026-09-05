# LatticeBar

A macOS menu-bar widget for [Lattice](../README.md): today's token usage, requests, cache hit
rate, spend and timing; a 30-day activity heat-map; top models, active threads and tool usage — all
for a selectable window (Today / 7d / 30d / All), and all echoing the app's in-app **Usage** page.

```
menubar/
├── LatticeBar/main.swift   # SwiftUI menu-bar app; decodes the snapshot JSON and renders
├── LatticeBar/LatticeBar   # built binary (copied into ~/Applications/LatticeBar.app)
├── Info.plist              # bundle metadata (LSUIElement — menu-bar agent, no Dock icon)
└── build.sh                # compile → bundle → install → (re)launch the launchd agent
```

## Architecture — one source of truth

Every number is computed **once**, in Lattice's main process, by the shared aggregator
[`src/shared/statsSnapshot.ts`](../src/shared/statsSnapshot.ts). Lattice mirrors that one
`StatsSnapshot` document to disk while it runs, and `main.swift` only decodes and draws it — so the
menu-bar label, the stat cards, the heat-map and the breakdown tables can never disagree with each
other or with the in-app Usage page.

| | |
| --- | --- |
| **Data file** | `~/Library/Application Support/Lattice/stats.json` (override with `LATTICEBAR_STATS`) |
| **Writer** | Lattice `src/main/stats.ts` — atomic write on launch + every 20 s while it changes, and a final `appOpen:false` snapshot on quit |
| **Reader** | LatticeBar polls the file every 15 s (and on the ↻ button); no ports, no subprocess |
| **Windows** | Today / 7d / 30d / All-time, each bucketed by the **local** calendar day |
| **Tokens** | cache-exclusive "fresh" totals (fresh input + output); cache read/write shown separately |
| **Cost** | provider-reported when present, else a user cost override (exact), else list-price estimate |

When `stats.json` is missing the widget explains how to create it (open Lattice once). When Lattice
has quit, the last snapshot is shown with an **Off** badge rather than a stale "live" reading.

## Build, QA, install

```bash
cd menubar
./build.sh --render      # writes /tmp/latticebar-{light,dark,label}.png from sample data
./build.sh               # compile → ~/Applications/LatticeBar.app → restart the menu-bar agent
```

Manual steps (what `build.sh` automates):

```bash
swiftc -O -parse-as-library -o LatticeBar/LatticeBar LatticeBar/main.swift
./LatticeBar/LatticeBar --render /tmp/out.png --live    # render the REAL stats.json (add --dark)
LATTICEBAR_STATS=/path/to/stats.json ./LatticeBar/LatticeBar   # point at a specific snapshot
```

launchd label: `com.dylan.latticebar`. One-line health summary, rewritten every refresh:

```bash
cat /tmp/latticebar.status
```

## Troubleshooting

* **Menu bar shows `—` / header says `—`**: `stats.json` isn't there yet. Launch Lattice once; it
  writes the file on startup. Confirm the path with `cat /tmp/latticebar.status`.
* **Header says `Off` (red/orange dot)**: the snapshot exists but Lattice isn't running (or the file
  is stale). Numbers are the last-known values from when Lattice last had them — there's no newer
  data to miss, since usage only changes while Lattice runs.
* **Numbers look off vs. the in-app Usage page**: they can't diverge in logic (same aggregator), only
  in freshness. Hit ↻, or check that Lattice is the version that writes `stats.json`.
