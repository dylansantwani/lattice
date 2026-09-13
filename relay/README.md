# Lattice relay: the iOS bridge without the Mac

The phone talks to `https://lattice.pulse-core.com`. Before the relay, that hostname was a Cloudflare
tunnel on the Mac pointing at Lattice.app's bridge, so the phone died whenever the laptop slept, the lid
closed on battery, or the app quit. The relay moves the front door to an always-on Proxmox container and
keeps a replica of the Mac's threads there.

```
iPhone ─► lattice.pulse-core.com (Cloudflare tunnel, connector in CT 149)
            └─► lattice-edge 127.0.0.1:8973 (CT 149)
                  ├─ Mac awake + app healthy ─► 127.0.0.1:18973 ══ reverse SSH ══► Mac 127.0.0.1:8973 (Lattice.app)
                  └─ otherwise ───────────────► 127.0.0.1:8975 lattice-cloud (headless runtime, replica DB)

Mac: com.pulsecore.lattice-relay agent ── every 10 s: sync both databases, then offer or withdraw the forward
```

- The phone never changes URL and never re-pairs: device tokens and the password hash are replicated.
- While the Mac is away, new chats and replies run in the container on API-key models (DeepSeek,
  OpenRouter, OpenCode Zen, Fireworks, NVIDIA) through a cloud OmniRoute. Claude/Codex subscriptions stay
  Mac-only on purpose: a second OmniRoute refreshing the same OAuth tokens would sign the Mac's out. The
  5080 models are only reachable through the Mac's SSH tunnels.
- Tools in cloud mode run inside the container (`/var/lib/lattice-cloud/workspace`), not on the Mac.
- When the Mac returns, the agent first pulls everything the phone did into the Mac's database, waits for
  any run the phone started in the cloud to go quiet, and only then offers the Mac back to the edge.

## Pieces

| Path | Runs on | What |
|---|---|---|
| `sync/lattice_relay_sync.py` | both | stdlib replication engine + `serve` JSON-RPC over stdin/stdout |
| `edge/lattice-edge.mjs` | CT | zero-dependency failover proxy (HTTP + WebSocket), `GET /edge/status` |
| `mac/lattice_relay_agent.py` | Mac | launchd agent: SSH master, sync loop, reverse forward on/off |
| `ct/install-ct.sh`, `ct/systemd/*` | CT | provisioning: user `lattice`, units, forced-command key, OmniRoute |
| `install.sh` | Mac | build, test, seed, install both halves, move the tunnel connector, prove failover |

### Replication rules (sync)

- **events**: append-only, rowid watermark per side. An import runs inside one `BEGIN IMMEDIATE`, so the
  rowids it creates are an exact range, excluded from that side's next export: mirrored rows are never
  echoed back.
- **threads + messages + thread_tools** move together. A thread is "touched" when its row or events
  changed; both sides hash it (row minus `cwd`, messages, tool set), and a differing thread is copied from
  the side whose row is newer as an exact replacement. Equal timestamps are a union that never deletes.
- **todos, memory, thread_groups, file_changes, memory_distill_marks**: last writer wins on the row's
  own timestamp. Memory FTS stays correct through the table's triggers.
- **workspaces**: Mac to cloud only, roots rewritten to the container workspace. `threads.cwd` is NULL on
  the cloud and never overwritten on the Mac.
- **meta**: device tokens unioned both ways; password hash Mac to cloud only.
- **deletions**: a thread both sides knew that vanishes from one side is deleted on the other, after a
  gzip JSON copy of every row goes to the trash directory. More than 5 in one cycle, or a database whose
  `relay.generation` id changed, is never treated as deletion. Event deletions (clear thread, retried
  turn) propagate only from the side whose thread row is newer, or in small numbers.

## Operate

```bash
bash ~/lattice/relay/install.sh --check        # preflight, changes nothing
bash ~/lattice/relay/install.sh                # install / upgrade + failover self-test
cat ~/Library/Application\ Support/Lattice/relay/status.json
tail -f /tmp/lattice-relay-agent.log
curl -s https://lattice.pulse-core.com/edge/status
touch ~/.lattice-relay-pause                   # send the phone to the cloud (rm to bring it back)
ssh pve "pct exec 149 -- systemctl status lattice-edge lattice-cloud lattice-tunnel omniroute"
```

Rollback to the Mac-only bridge: `launchctl bootout gui/$UID/com.pulsecore.lattice-relay`, move
`~/Library/LaunchAgents/disabled/com.pulsecore.lattice-tunnel.plist` back and `launchctl bootstrap` it,
then `ssh pve "pct exec 149 -- systemctl disable --now lattice-tunnel lattice-edge lattice-cloud omniroute"`.

## Tests

```bash
python3 -m unittest discover -s relay/sync/tests      # 18 tests, real schema incl. FTS triggers
node --test relay/edge/lattice-edge.test.mjs           # 6 tests, fake Mac/cloud + WebSocket switchover
python3 -m unittest discover -s relay/mac/tests       # 6 tests, agent decisions (health, failback hold, forward)
```

Also exercised on a byte copy of the real 625 MB database: steady cycles 26 to 40 ms, 3,000 Mac events
plus a phone-created thread crossed in 82 ms, no echo, all 132 thread digests equal afterwards.
