#!/usr/bin/env python3
"""
lattice-relay-agent — the Mac half of the always-on bridge. Runs forever under launchd
(com.pulsecore.lattice-relay, installed by relay/mac/install-mac.sh).

Every INTERVAL seconds it:

  1. keeps one SSH master connection to the relay container (ProxyJump through the Proxmox host:
     `pve` on the LAN, `pve-tunnel` over Cloudflare Access anywhere else);
  2. runs one replication cycle between this Mac's lattice.db and the cloud replica (relay/sync),
     through a `serve` session on that connection — the container's forced command allows nothing else;
  3. decides whether the phone should be talking to this Mac: only while Lattice.app's bridge answers
     /health locally AND the cloud is not in the middle of a run the phone started while the Mac was
     away. When it should, it adds the reverse forward 127.0.0.1:18973 -> 127.0.0.1:8973 to the master;
     when it should not, it cancels it. The edge in the container routes to the Mac exactly while that
     forward answers.

Sleep needs no handling: a sleeping Mac stops answering, the container's sshd reaps the session
(ClientAliveInterval), the forward disappears, and the edge fails over to the cloud within seconds.
On wake the loop reconnects, syncs what the phone did in the meantime into this database first, and
only then offers the forward again.

Touch ~/.lattice-relay-pause to stand the agent down (forward cancelled, no syncing) — e.g. before
restoring a database backup.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import traceback
import urllib.request
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
for candidate in (os.path.join(HERE, "..", "sync"), HERE):
    if os.path.exists(os.path.join(candidate, "lattice_relay_sync.py")):
        sys.path.insert(0, os.path.abspath(candidate))
        break
import lattice_relay_sync as rs  # noqa: E402

HOME = os.path.expanduser("~")
SUPPORT = os.path.join(HOME, "Library", "Application Support", "Lattice")
RELAY_DIR = os.path.join(SUPPORT, "relay")

DEFAULTS: Dict[str, Any] = {
    "mac_db": os.path.join(SUPPORT, "data", "lattice.db"),
    "ct_id": 149,
    "ct_user": "lattice",
    "ct_host": "",
    "jumps": ["pve", "pve-tunnel"],
    "identity": os.path.join(HOME, ".ssh", "lattice_relay_ed25519"),
    "known_hosts": os.path.join(RELAY_DIR, "known_hosts"),
    "local_port": 8973,
    "remote_port": 18973,
    "interval": 10,
    "busy_interval": 3,
    "full_reconcile_every": 60,
    "failback_max_wait_s": 1200,
    "cloud_root": "/var/lib/lattice-cloud/workspace",
    "trash_dir": os.path.join(RELAY_DIR, "trash"),
    "state_file": os.path.join(RELAY_DIR, "state.json"),
    "status_file": os.path.join(RELAY_DIR, "status.json"),
    "log_file": "/tmp/lattice-relay-agent.log",
    "pause_file": os.path.join(HOME, ".lattice-relay-pause"),
}

SSH = "/usr/bin/ssh"


def load_config() -> Dict[str, Any]:
    cfg = dict(DEFAULTS)
    path = os.path.join(RELAY_DIR, "config.json")
    if os.path.exists(path):
        with open(path) as fh:
            cfg.update(json.load(fh))
    return cfg


class Agent:
    def __init__(self, cfg: Dict[str, Any]) -> None:
        self.cfg = cfg
        os.makedirs(RELAY_DIR, exist_ok=True)
        self.control = os.path.join("/tmp", f"lattice-relay-{os.getuid()}.sock")
        self.master: Optional[subprocess.Popen] = None
        self.serve_proc: Optional[subprocess.Popen] = None
        self.remote: Optional[rs.RpcSide] = None
        self.jump: str = ""
        self.forward_open = False
        self.cloud_busy_since = 0
        self.state = self._load_state()
        self.store = rs.Store(cfg["mac_db"], "mac", trash_dir=cfg["trash_dir"])
        self.local = rs.LocalSide(self.store, "mac")
        self.last_error = ""
        self.last_report: Dict[str, Any] = {}
        self.stopping = False

    # ------------------------------------------------------------------ io
    def log(self, msg: str) -> None:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n"
        try:
            path = self.cfg["log_file"]
            if os.path.exists(path) and os.path.getsize(path) > 2 * 1024 * 1024:
                os.replace(path, path + ".1")
            with open(path, "a") as fh:
                fh.write(line)
        except OSError:
            pass

    def _load_state(self) -> Dict[str, Any]:
        try:
            with open(self.cfg["state_file"]) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return rs.empty_state()

    def save_state(self) -> None:
        tmp = self.cfg["state_file"] + ".tmp"
        slim = {k: v for k, v in self.state.items() if k != "last_report"}
        with open(tmp, "w") as fh:
            json.dump(slim, fh)
        os.replace(tmp, self.cfg["state_file"])

    def write_status(self, phase: str) -> None:
        status = {
            "phase": phase,
            "at": rs.now_ms(),
            "jump": self.jump,
            "ct_host": self.cfg.get("ct_host"),
            "forward_open": self.forward_open,
            "cycles": self.state.get("cycles", 0),
            "last_ok": self.state.get("last_ok", 0),
            "last_error": self.last_error,
            "warnings": (self.state.get("warnings") or [])[-5:],
            "last_report": self.last_report,
        }
        tmp = self.cfg["status_file"] + ".tmp"
        try:
            with open(tmp, "w") as fh:
                json.dump(status, fh, indent=2)
            os.replace(tmp, self.cfg["status_file"])
        except OSError:
            pass

    # ------------------------------------------------------------------ ssh
    def _ssh_base(self, jump: str) -> List[str]:
        return [
            SSH,
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=10",
            "-o", "ServerAliveCountMax=3",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", f"UserKnownHostsFile={self.cfg['known_hosts']}",
            "-o", "IdentitiesOnly=yes",
            "-i", self.cfg["identity"],
            "-J", jump,
        ]

    def discover_host(self) -> Optional[str]:
        for jump in self.cfg["jumps"]:
            try:
                out = subprocess.run(
                    [SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", jump, f"pct exec {int(self.cfg['ct_id'])} -- hostname -I"],
                    capture_output=True, text=True, timeout=40,
                )
            except subprocess.TimeoutExpired:
                continue
            addrs = [a for a in out.stdout.split() if a.count(".") == 3]
            if out.returncode == 0 and addrs:
                return addrs[0]
        return None

    def connect(self) -> bool:
        self.teardown()
        host = self.cfg.get("ct_host") or self.discover_host()
        if not host:
            self.last_error = "cannot resolve the relay container address through any jump host"
            return False
        self.cfg["ct_host"] = host
        target = f"{self.cfg['ct_user']}@{host}"
        for jump in self.cfg["jumps"]:
            try:
                os.unlink(self.control)
            except OSError:
                pass
            cmd = self._ssh_base(jump) + ["-M", "-S", self.control, "-o", "ControlPersist=no", "-N", target]
            master = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.time() + 45
            while time.time() < deadline:
                if master.poll() is not None:
                    break
                check = subprocess.run([SSH, "-S", self.control, "-O", "check", target], capture_output=True, text=True)
                if check.returncode == 0:
                    self.master, self.jump = master, jump
                    break
                time.sleep(0.5)
            if self.master:
                break
            err = ""
            if master.poll() is None:
                master.terminate()
            try:
                err = (master.stderr.read() or "").strip()[-300:] if master.stderr else ""
            except Exception:
                pass
            self.last_error = f"ssh via {jump} failed: {err or 'timeout'}"
            self.log(self.last_error)
        if not self.master:
            # the address may have changed (DHCP); rediscover next time
            self.cfg["ct_host"] = ""
            return False
        self.serve_proc = subprocess.Popen(
            [SSH, "-S", self.control, "-T", target, "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self.remote = rs.RpcSide(self.serve_proc, "cloud")
        hello = self.remote.call("hello")
        self.log(f"connected via {self.jump} to {host}: cloud has {hello['thread_count']} threads, {hello['event_count']} events")
        return True

    def forward(self, open_it: bool) -> None:
        if not self.master or self.forward_open == open_it:
            return
        spec = f"127.0.0.1:{self.cfg['remote_port']}:127.0.0.1:{self.cfg['local_port']}"
        target = f"{self.cfg['ct_user']}@{self.cfg['ct_host']}"
        op = "forward" if open_it else "cancel"
        res = subprocess.run([SSH, "-S", self.control, "-O", op, "-R", spec, target], capture_output=True, text=True, timeout=20)
        if res.returncode == 0:
            self.forward_open = open_it
            self.log(f"reverse forward {'opened' if open_it else 'cancelled'} ({spec})")
        else:
            self.last_error = f"forward {op} failed: {res.stderr.strip()[-200:]}"
            self.log(self.last_error)

    def teardown(self) -> None:
        self.forward_open = False
        for proc in (self.serve_proc, self.master):
            if proc and proc.poll() is None:
                try:
                    if proc.stdin:
                        proc.stdin.close()
                except Exception:
                    pass
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
        self.serve_proc = self.master = None
        self.remote = None

    def alive(self) -> bool:
        return bool(self.master and self.master.poll() is None and self.serve_proc and self.serve_proc.poll() is None)

    # ------------------------------------------------------------------ decisions
    def local_healthy(self) -> bool:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.cfg['local_port']}/health", timeout=3) as r:
                return r.status == 200 and json.loads(r.read().decode()).get("ok") is True
        except Exception:
            return False

    def should_offer_mac(self, report: Dict[str, Any]) -> bool:
        if not self.local_healthy():
            return False
        if self.forward_open:
            return True
        # Failing back: never pull the phone off a run it started on the cloud. Wait (still syncing)
        # until the cloud has been quiet, bounded so a stuck run cannot pin the phone there forever.
        cloud = (report.get("hello") or {}).get("cloud") or {}
        if cloud.get("recent_events", 0) > 0:
            if not self.cloud_busy_since:
                self.cloud_busy_since = time.time()
                self.log("cloud is mid-run; holding the phone on the cloud until it is quiet")
            if time.time() - self.cloud_busy_since < self.cfg["failback_max_wait_s"]:
                return False
        self.cloud_busy_since = 0
        return True

    # ------------------------------------------------------------------ loop
    def run(self) -> None:
        self.log(f"agent start pid={os.getpid()} db={self.cfg['mac_db']}")
        backoff = 5
        while not self.stopping:
            if os.path.exists(self.cfg["pause_file"]):
                if self.master:
                    self.forward(False)
                    self.teardown()
                    self.log("paused")
                self.write_status("paused")
                time.sleep(5)
                continue
            try:
                if not self.alive():
                    self.write_status("connecting")
                    if not self.connect():
                        self.write_status("offline")
                        time.sleep(backoff)
                        backoff = min(backoff * 2, 60)
                        continue
                    backoff = 5
                cycles = int(self.state.get("cycles", 0))
                reconcile = cycles % int(self.cfg["full_reconcile_every"]) == 0
                started = time.time()
                report = rs.sync_cycle(self.local, self.remote, self.state, cloud_root=self.cfg["cloud_root"], reconcile=reconcile, log=self.log)
                self.save_state()
                moved = sum(report["events"].values()) + sum(report["lww"].values()) + sum(report["threads"].values())
                self.last_report = {k: report[k] for k in ("events", "lww", "threads", "deleted", "warnings")}
                self.last_report["ms"] = int((time.time() - started) * 1000)
                if moved or report["deleted"] or report["warnings"]:
                    self.log(f"cycle {self.state['cycles']}: {json.dumps(self.last_report)}")
                self.forward(self.should_offer_mac(report))
                self.last_error = ""
                self.write_status("serving-mac" if self.forward_open else "cloud-serving")
                time.sleep(self.cfg["busy_interval"] if moved > 200 else self.cfg["interval"])
            except Exception as e:  # any failure: drop the connection (and so the forward) and retry
                self.last_error = f"{type(e).__name__}: {e}"
                self.log(f"cycle failed: {self.last_error}\n{traceback.format_exc()[-1500:]}")
                self.teardown()
                self.write_status("error")
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
        self.forward(False)
        self.teardown()
        self.write_status("stopped")


def main(argv: List[str]) -> int:
    cfg = load_config()
    if len(argv) > 1 and argv[1] == "baseline":
        # relay/mac/install-mac.sh: after the cloud was seeded from a snapshot, record that snapshot's
        # watermarks as the starting cursors so the first cycle only moves what changed since the copy.
        marks = json.loads(open(argv[2]).read())
        agent = Agent(cfg)
        if not agent.connect():
            print(agent.last_error, file=sys.stderr)
            return 1
        agent.state = rs.baseline_state(agent.local, agent.remote, marks)
        agent.save_state()
        agent.teardown()
        print(json.dumps({"ok": True, "known_threads": len(agent.state["known_threads"]), "cursors": agent.state["cursors"]}))
        return 0
    if len(argv) > 1 and argv[1] == "once":
        agent = Agent(cfg)
        if not agent.connect():
            print(agent.last_error, file=sys.stderr)
            return 1
        report = rs.sync_cycle(agent.local, agent.remote, agent.state, cloud_root=cfg["cloud_root"])
        agent.save_state()
        agent.teardown()
        print(json.dumps({k: report[k] for k in ("events", "lww", "threads", "deleted", "warnings", "hello")}, indent=2))
        return 0
    agent = Agent(cfg)

    def stop(*_: Any) -> None:
        agent.stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    agent.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
