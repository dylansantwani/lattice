"""Offline tests for lattice_relay_sync against the real Lattice schema (tests/schema.sql is a `.schema`
dump of a live desktop database, FTS triggers included). Run:

    python3 -m unittest discover -s relay/sync/tests
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import lattice_relay_sync as rs  # noqa: E402

SCHEMA = open(os.path.join(HERE, "schema.sql")).read()


def make_db(path: str) -> None:
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("INSERT INTO workspaces (id, name, roots_json, created_at) VALUES ('ws1', 'Home', '[\"/Users/dylan\"]', 1)")
    db.commit()
    db.close()


class Env:
    """Two databases standing in for the Mac and the cloud, plus direct SQL handles to play the app."""

    def __init__(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="relay-sync-")
        self.mac_path = os.path.join(self.dir, "mac.db")
        self.cloud_path = os.path.join(self.dir, "cloud.db")
        make_db(self.mac_path)
        shutil.copy(self.mac_path, self.cloud_path)
        self.trash = os.path.join(self.dir, "trash")
        self.mac_store = rs.Store(self.mac_path, "mac", trash_dir=self.trash)
        self.cloud_store = rs.Store(self.cloud_path, "cloud", trash_dir=os.path.join(self.dir, "cloud-trash"))
        self.mac = rs.LocalSide(self.mac_store, "mac")
        self.cloud = rs.LocalSide(self.cloud_store, "cloud")
        self.state = rs.empty_state()

    def app(self, which: str) -> sqlite3.Connection:
        db = sqlite3.connect(self.mac_path if which == "mac" else self.cloud_path, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    def cycle(self, reconcile: bool = False) -> dict:
        return rs.sync_cycle(self.mac, self.cloud, self.state, cloud_root="/srv/ws", reconcile=reconcile)

    def close(self) -> None:
        self.mac_store.close()
        self.cloud_store.close()
        shutil.rmtree(self.dir, ignore_errors=True)


_ids = [0]


def nid(prefix: str) -> str:
    _ids[0] += 1
    return f"{prefix}{_ids[0]:06d}"


def add_thread(db: sqlite3.Connection, tid: str, title: str = "t", updated: int = 0, cwd: str = None) -> None:
    ts = updated or rs.now_ms()
    db.execute(
        "INSERT INTO threads (id, workspace_id, title, created_at, updated_at, model, cwd) VALUES (?, 'ws1', ?, ?, ?, 'deepseek/deepseek-v4-flash', ?)",
        (tid, title, ts, ts, cwd),
    )


def add_message(db: sqlite3.Connection, tid: str, role: str = "user", text: str = "hi", status: str = None) -> str:
    mid = nid("m")
    db.execute(
        "INSERT INTO messages (id, thread_id, role, created_at, text, status) VALUES (?, ?, ?, ?, ?, ?)",
        (mid, tid, role, rs.now_ms(), text, status),
    )
    db.execute("UPDATE threads SET updated_at = ? WHERE id = ?", (rs.now_ms(), tid))
    return mid


def add_events(db: sqlite3.Connection, tid: str, run: str, n: int) -> list:
    out = []
    row = db.execute("SELECT MAX(seq) AS m FROM events WHERE run_id = ?", (run,)).fetchone()
    seq = (row["m"] if row["m"] is not None else -1) + 1
    for i in range(n):
        eid = nid("e")
        db.execute(
            "INSERT INTO events (id, run_id, thread_id, seq, ts, body_json) VALUES (?, ?, ?, ?, ?, ?)",
            (eid, run, tid, seq + i, rs.now_ms(), json.dumps({"kind": "text.delta", "i": i})),
        )
        out.append(eid)
    return out


def count(db: sqlite3.Connection, sql: str, *params) -> int:
    return db.execute(sql, params).fetchone()[0]


class MirrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = Env()

    def tearDown(self) -> None:
        self.env.close()

    def test_mac_thread_mirrors_to_cloud_and_does_not_echo(self) -> None:
        mac = self.env.app("mac")
        add_thread(mac, "T1", cwd="/Users/dylan/proj")
        add_message(mac, "T1", "user", "hello")
        add_message(mac, "T1", "assistant", "hi there", "complete")
        add_events(mac, "T1", "R1", 50)
        rep = self.env.cycle()
        cloud = self.env.app("cloud")
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM messages WHERE thread_id='T1'"), 2)
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM events WHERE thread_id='T1'"), 50)
        self.assertIsNone(cloud.execute("SELECT cwd FROM threads WHERE id='T1'").fetchone()[0], "cloud never inherits a Mac path")
        self.assertEqual(rep["events"], {"mac->cloud": 50})
        # nothing new: the 50 events imported into the cloud must not come back
        rep2 = self.env.cycle()
        self.assertEqual(rep2["events"], {})
        self.assertEqual(rep2["threads"], {})
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM events"), 50)

    def test_workspace_roots_are_rewritten_for_cloud(self) -> None:
        self.env.cycle()
        cloud = self.env.app("cloud")
        self.assertEqual(json.loads(cloud.execute("SELECT roots_json FROM workspaces WHERE id='ws1'").fetchone()[0]), ["/srv/ws"])
        mac = self.env.app("mac")
        self.assertEqual(json.loads(mac.execute("SELECT roots_json FROM workspaces WHERE id='ws1'").fetchone()[0]), ["/Users/dylan"])

    def test_cloud_thread_flows_back_to_mac(self) -> None:
        cloud = self.env.app("cloud")
        add_thread(cloud, "C1", title="from phone")
        add_message(cloud, "C1", "user", "while the mac slept")
        add_message(cloud, "C1", "assistant", "done", "complete")
        add_events(cloud, "C1", "RC", 12)
        rep = self.env.cycle()
        mac = self.env.app("mac")
        self.assertEqual(mac.execute("SELECT title FROM threads WHERE id='C1'").fetchone()[0], "from phone")
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM messages WHERE thread_id='C1'"), 2)
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM events WHERE thread_id='C1'"), 12)
        self.assertEqual(rep["events"], {"cloud->mac": 12})
        self.assertEqual(self.env.cycle()["events"], {})

    def test_streaming_reply_updates_follow(self) -> None:
        mac = self.env.app("mac")
        add_thread(mac, "T1")
        mid = add_message(mac, "T1", "assistant", "par", None)
        add_events(mac, "T1", "R1", 3)
        self.env.cycle()
        mac.execute("UPDATE messages SET text = 'partial reply, now longer' WHERE id = ?", (mid,))
        add_events(mac, "T1", "R1", 3)
        self.env.cycle()
        cloud = self.env.app("cloud")
        self.assertEqual(cloud.execute("SELECT text FROM messages WHERE id=?", (mid,)).fetchone()[0], "partial reply, now longer")
        mac.execute("UPDATE messages SET status = 'complete' WHERE id = ?", (mid,))
        add_events(mac, "T1", "R1", 1)
        self.env.cycle()
        self.assertEqual(cloud.execute("SELECT status FROM messages WHERE id=?", (mid,)).fetchone()[0], "complete")

    def test_last_writer_wins_on_thread_row_and_mac_cwd_is_protected(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1", title="old", cwd="/Users/dylan/proj")
        self.env.cycle()
        later = rs.now_ms() + 5000
        cloud.execute("UPDATE threads SET title = 'renamed on phone', updated_at = ? WHERE id = 'T1'", (later,))
        self.env.cycle()
        row = mac.execute("SELECT title, cwd FROM threads WHERE id='T1'").fetchone()
        self.assertEqual(row[0], "renamed on phone")
        self.assertEqual(row[1], "/Users/dylan/proj")
        # an older write on the mac does not clobber it
        mac.execute("UPDATE threads SET title = 'stale', updated_at = ? WHERE id = 'T1'", (later - 1000,))
        self.env.cycle()
        self.assertEqual(cloud.execute("SELECT title FROM threads WHERE id='T1'").fetchone()[0], "renamed on phone")

    def test_todos_and_memory_sync_with_fts_intact(self) -> None:
        mac = self.env.app("mac")
        add_thread(mac, "T1")
        now = rs.now_ms()
        mac.execute("INSERT INTO todos (id, thread_id, workspace_id, title, created_at, updated_at) VALUES ('td1','T1','ws1','ship it',?,?)", (now, now))
        mac.execute(
            "INSERT INTO memory (id, scope, type, content, author, created_at, updated_at) VALUES ('mem1','global','fact','the relay keeps phones alive','agent',?,?)",
            (now, now),
        )
        self.env.cycle()
        cloud = self.env.app("cloud")
        self.assertEqual(cloud.execute("SELECT title FROM todos WHERE id='td1'").fetchone()[0], "ship it")
        hits = cloud.execute("SELECT m.id FROM memory_fts f JOIN memory m ON m.rowid = f.rowid WHERE memory_fts MATCH 'relay'").fetchall()
        self.assertEqual([h[0] for h in hits], ["mem1"])


class DeletionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = Env()

    def tearDown(self) -> None:
        self.env.close()

    def test_thread_deleted_on_mac_is_deleted_on_cloud(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1")
        add_message(mac, "T1")
        add_events(mac, "T1", "R", 5)
        self.env.cycle()
        self.env.cycle()
        for t in ("messages", "events", "thread_tools", "file_changes", "memory_distill_marks"):
            mac.execute(f"DELETE FROM {t} WHERE thread_id='T1'")
        mac.execute("DELETE FROM threads WHERE id='T1'")
        rep = self.env.cycle()
        self.assertEqual(rep["deleted"], {"threads:mac->cloud": 1})
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM threads WHERE id='T1'"), 0)
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM events WHERE thread_id='T1'"), 0)

    def test_thread_deleted_on_cloud_is_trashed_then_deleted_on_mac(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1", title="keep a copy")
        add_message(mac, "T1", "user", "important")
        self.env.cycle()
        self.env.cycle()
        cloud.execute("DELETE FROM messages WHERE thread_id='T1'")
        cloud.execute("DELETE FROM threads WHERE id='T1'")
        rep = self.env.cycle()
        self.assertEqual(rep["deleted"], {"threads:cloud->mac": 1})
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM threads WHERE id='T1'"), 0)
        files = os.listdir(self.env.trash)
        self.assertEqual(len(files), 1)
        with gzip.open(os.path.join(self.env.trash, files[0]), "rt") as fh:
            saved = json.load(fh)
        self.assertEqual(saved["thread"]["title"], "keep a copy")
        self.assertEqual(saved["messages"][0]["text"], "important")

    def test_mass_disappearance_is_not_propagated(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        for i in range(8):
            add_thread(mac, f"T{i}")
        self.env.cycle()
        self.env.cycle()
        cloud.execute("DELETE FROM threads")
        rep = self.env.cycle()
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM threads"), 8)
        self.assertTrue(rep["warnings"])

    def test_replaced_database_is_rebaselined_not_diffed(self) -> None:
        mac = self.env.app("mac")
        for i in range(3):
            add_thread(mac, f"T{i}")
            add_message(mac, f"T{i}")
        self.env.cycle()
        self.env.cycle()
        # the cloud database is wiped and recreated (new generation)
        self.env.cloud_store.close()
        os.remove(self.env.cloud_path)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(self.env.cloud_path + suffix):
                os.remove(self.env.cloud_path + suffix)
        make_db(self.env.cloud_path)
        self.env.cloud_store = rs.Store(self.env.cloud_path, "cloud")
        self.env.cloud = rs.LocalSide(self.env.cloud_store, "cloud")
        self.env.cycle()
        self.assertEqual(count(mac, "SELECT COUNT(*) FROM threads"), 3, "an empty replacement must never delete the Mac's threads")
        cloud = self.env.app("cloud")
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM threads"), 3, "and it gets repopulated")

    def test_cleared_thread_content_reconciles(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1")
        add_message(mac, "T1")
        add_events(mac, "T1", "R", 30)
        self.env.cycle()
        self.env.cycle()
        mac.execute("DELETE FROM messages WHERE thread_id='T1'")
        mac.execute("DELETE FROM events WHERE thread_id='T1'")
        mac.execute("UPDATE threads SET updated_at = ? WHERE id='T1'", (rs.now_ms() + 10,))
        self.env.cycle()  # an ordinary cycle, no full reconcile requested
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM messages WHERE thread_id='T1'"), 0)
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM events WHERE thread_id='T1'"), 0)


class AuthAndBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = Env()

    def tearDown(self) -> None:
        self.env.close()

    def test_tokens_union_and_password_flows_mac_to_cloud_only(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        far = rs.now_ms() + 10**9
        mac.execute("INSERT INTO meta (key, value) VALUES ('remote.passwordHash', 'scrypt$aa$bb')")
        mac.execute("INSERT INTO meta (key, value) VALUES ('remote.tokens', ?)", (json.dumps([{"token": "mac-phone", "device": "iPhone", "createdAt": 1, "expiresAt": far, "lastSeenAt": 1}]),))
        cloud.execute("INSERT INTO meta (key, value) VALUES ('remote.passwordHash', 'scrypt$cloud$old')")
        cloud.execute("INSERT INTO meta (key, value) VALUES ('remote.tokens', ?)", (json.dumps([{"token": "cloud-phone", "device": "iPhone", "createdAt": 2, "expiresAt": far, "lastSeenAt": 2}, {"token": "expired", "device": "x", "createdAt": 0, "expiresAt": 5, "lastSeenAt": 0}]),))
        self.env.cycle()
        mt = {t["token"] for t in json.loads(mac.execute("SELECT value FROM meta WHERE key='remote.tokens'").fetchone()[0])}
        ct = {t["token"] for t in json.loads(cloud.execute("SELECT value FROM meta WHERE key='remote.tokens'").fetchone()[0])}
        self.assertEqual(mt, {"mac-phone", "cloud-phone"})
        self.assertEqual(ct, {"mac-phone", "cloud-phone"})
        self.assertEqual(cloud.execute("SELECT value FROM meta WHERE key='remote.passwordHash'").fetchone()[0], "scrypt$aa$bb")
        self.assertEqual(mac.execute("SELECT value FROM meta WHERE key='remote.passwordHash'").fetchone()[0], "scrypt$aa$bb")

    def test_baseline_from_snapshot_marks_moves_only_what_changed_after_the_copy(self) -> None:
        mac = self.env.app("mac")
        for i in range(4):
            add_thread(mac, f"T{i}")
            add_message(mac, f"T{i}")
            add_events(mac, f"T{i}", f"R{i}", 100)
        # snapshot -> seed the cloud with a byte copy
        snap = os.path.join(self.env.dir, "snap.db")
        src = sqlite3.connect(self.env.mac_path)
        dst = sqlite3.connect(snap)
        src.backup(dst)
        dst.close()
        src.close()
        marks = rs.Store(snap, "mac").watermarks()
        self.env.cloud_store.close()
        shutil.copy(snap, self.env.cloud_path)
        for suffix in ("-wal", "-shm"):
            if os.path.exists(self.env.cloud_path + suffix):
                os.remove(self.env.cloud_path + suffix)
        rs.main(["prepare-cloud", "--db", self.env.cloud_path, "--cloud-root", "/srv/ws", "--providers-json", "[]"])
        self.env.cloud_store = rs.Store(self.env.cloud_path, "cloud")
        self.env.cloud = rs.LocalSide(self.env.cloud_store, "cloud")
        # the mac keeps working after the copy was taken
        add_events(mac, "T0", "R0", 7)
        add_message(mac, "T1", "user", "after the copy")
        self.env.state = rs.baseline_state(self.env.mac, self.env.cloud, marks)
        rep = self.env.cycle()
        self.assertEqual(rep["events"], {"mac->cloud": 7})
        cloud = self.env.app("cloud")
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM events"), 407)
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM messages WHERE thread_id='T1'"), 2)
        self.assertEqual(self.env.cycle()["events"], {})

    def test_serve_over_pipes_matches_local(self) -> None:
        mac = self.env.app("mac")
        add_thread(mac, "T1")
        add_events(mac, "T1", "R", 5)
        proc = subprocess.Popen(
            [sys.executable, os.path.join(os.path.dirname(HERE), "lattice_relay_sync.py"), "serve", "--db", self.env.cloud_path, "--role", "cloud"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        try:
            remote = rs.RpcSide(proc, "cloud")
            self.assertEqual(remote.call("hello")["role"], "cloud")
            with self.assertRaises(rs.RemoteError):
                remote.call("close")  # not an allowed method
            rs.sync_cycle(self.env.mac, remote, self.env.state, cloud_root="/srv/ws")
            self.assertEqual(remote.call("event_counts"), {"T1": 5})
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)
            proc.stdout.close()

    def test_export_page_and_mark_come_from_one_snapshot(self) -> None:
        mac = self.env.app("mac")
        add_thread(mac, "T1")
        add_events(mac, "T1", "R", rs.EVENT_PAGE + 10)
        page = self.env.mac_store.export_events(after=0)
        self.assertTrue(page["more"])
        self.assertEqual(len(page["rows"]), rs.EVENT_PAGE)
        page2 = self.env.mac_store.export_events(after=page["last_rowid"])
        self.assertEqual(len(page2["rows"]), 10)
        self.assertFalse(page2["more"])

    def test_small_event_deletion_propagates_on_full_reconcile(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1")
        ids = add_events(mac, "T1", "R", 40)
        self.env.cycle()
        self.env.cycle()
        mac.execute("DELETE FROM events WHERE id IN (?, ?)", (ids[0], ids[1]))
        self.env.cycle(reconcile=True)
        self.assertEqual(count(cloud, "SELECT COUNT(*) FROM events WHERE thread_id='T1'"), 38)

    def test_rename_only_propagates(self) -> None:
        mac, cloud = self.env.app("mac"), self.env.app("cloud")
        add_thread(mac, "T1", title="before")
        add_message(mac, "T1")
        self.env.cycle()
        mac.execute("UPDATE threads SET title='after', updated_at=? WHERE id='T1'", (rs.now_ms() + 50,))
        self.env.cycle()
        self.assertEqual(cloud.execute("SELECT title FROM threads WHERE id='T1'").fetchone()[0], "after")

    def test_mark_interrupted(self) -> None:
        cloud = self.env.app("cloud")
        add_thread(cloud, "T1")
        add_message(cloud, "T1", "assistant", "cut off", None)
        self.assertEqual(self.env.cloud_store.mark_interrupted()["marked"], 1)
        self.assertEqual(cloud.execute("SELECT status FROM messages WHERE thread_id='T1'").fetchone()[0], "interrupted")


if __name__ == "__main__":
    unittest.main()
