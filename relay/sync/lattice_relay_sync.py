#!/usr/bin/env python3
"""
lattice-relay-sync: two-way replication between the Mac's Lattice database and the always-on
cloud copy that serves the iOS app while the Mac is asleep or off.

Why this exists
---------------
The phone talks to `lattice.pulse-core.com`, which now lands on an always-on edge (relay/edge) in
a Proxmox container. The edge forwards to the Mac's own bridge when the Mac is reachable and to a
headless Lattice (same runtime, src/headless) in the container when it is not. For that failover to
be invisible, both runtimes have to hold the same threads. This file keeps them that way.

Shape
-----
One stdlib-only file that runs in three roles:

  serve   a line-delimited JSON-RPC server over stdin/stdout, bound to one database. The Mac-side
          agent starts it on the container through a restricted SSH key (forced command), so the
          container never needs credentials for the Mac.
  agent   the replication loop (relay/mac/lattice_relay_agent.py imports `Store` and `sync_cycle`).
  cli     one-shot maintenance: `info`, `backup`, `mark-interrupted`, `prepare-cloud`.

Both databases are live: the desktop app (better-sqlite3, WAL) and the headless backend keep writing
while this runs. Everything here is therefore short transactions, `busy_timeout`, and row-level
merge rules that never need a global lock:

  events                append-only. Exported by rowid watermark, imported with INSERT OR IGNORE.
                        Rows an import creates occupy an exact rowid range (the insert runs inside
                        one BEGIN IMMEDIATE, so no other writer can interleave), which is excluded
                        from that side's next export. That is what stops every mirrored event from
                        being echoed straight back.
  threads, todos,       last-writer-wins on their own timestamp (updated_at / last_at).
  thread_groups,
  memory, file_changes,
  memory_distill_marks
  messages,             thread-scoped. A thread whose events or row changed is "touched"; both sides
  thread_tools          hash that thread's messages + tool set, and only a thread whose digests differ
                        is copied, from the side whose thread row is newer, as an exact replacement.
  workspaces            Mac -> cloud only, with roots rewritten to the container's workspace.
  meta remote.*         device tokens are unioned both ways (so a phone that re-paired against the
                        cloud stays signed in on the Mac); the password hash flows Mac -> cloud only.

Deletions: a thread both sides knew about that disappears from one side is deleted on the other.
Deleting on the Mac is always preceded by a gzip JSON copy of every row into a trash directory, and
both directions stop at a safety valve (a replaced or empty database must never read as "the user
deleted everything"). Per-thread event/message deletions (clear thread, retried turn) are reconciled
the same way, bounded by the same valve.

Python 3.9 compatible (the Mac's /usr/bin/python3).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

PROTOCOL = 1

# table -> (key columns, timestamp column)
LWW_TABLES: Dict[str, Tuple[Tuple[str, ...], str]] = {
    "workspaces": (("id",), "created_at"),  # special-cased: mac -> cloud, full table
    "threads": (("id",), "updated_at"),
    "thread_groups": (("id",), "updated_at"),
    "todos": (("id",), "updated_at"),
    "memory": (("id",), "updated_at"),
    "memory_distill_marks": (("thread_id",), "updated_at"),
    "file_changes": (("thread_id", "path"), "last_at"),
}
# Order matters on import: parents before children keeps the desktop UI from ever listing a message
# whose thread row has not landed yet.
LWW_ORDER = ["threads", "thread_groups", "todos", "memory", "memory_distill_marks", "file_changes"]

# Tables whose rows belong to a thread and are deleted with it (mirrors eventStore.deleteThread).
THREAD_CHILD_TABLES = ["messages", "events", "file_changes", "thread_tools", "memory_distill_marks"]

META_PASSWORD = "remote.passwordHash"
META_TOKENS = "remote.tokens"
META_GENERATION = "relay.generation"

EVENT_PAGE = 2000
LWW_PAGE = 1000
LWW_MARGIN_MS = 30_000

# safety valves
MAX_THREAD_DELETES_PER_CYCLE = 5
MAX_ROW_DELETES_PER_THREAD = 500
MAX_ROW_DELETE_FRACTION = 0.25

RPC_METHODS = {
    "hello",
    "export_lww",
    "export_events",
    "thread_digests",
    "export_threads",
    "import_rows",
    "import_threads",
    "thread_ids",
    "thread_versions",
    "event_counts",
    "message_counts",
    "row_ids",
    "delete_rows",
    "delete_threads",
    "get_meta",
    "merge_meta",
    "mark_interrupted",
    "watermarks",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def _key_str(values: Sequence[Any]) -> str:
    return json.dumps(list(values), separators=(",", ":"))


class Store:
    """One Lattice database. Every public method takes and returns JSON-able values."""

    def __init__(self, path: str, role: str, trash_dir: Optional[str] = None) -> None:
        if role not in ("mac", "cloud"):
            raise ValueError("role must be mac or cloud")
        if not os.path.exists(path):
            raise FileNotFoundError(path)
        self.path = path
        self.role = role
        self.trash_dir = trash_dir
        # isolation_level=None: we issue BEGIN/COMMIT ourselves so each transaction stays short.
        self.db = sqlite3.connect(path, timeout=20, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout = 20000")
        self._columns: Dict[str, List[str]] = {}

    # ------------------------------------------------------------------ helpers
    def close(self) -> None:
        self.db.close()

    def columns(self, table: str) -> List[str]:
        if table not in self._columns:
            rows = self.db.execute(f"PRAGMA table_info({table})").fetchall()
            self._columns[table] = [r["name"] for r in rows]
        return self._columns[table]

    def has_table(self, table: str) -> bool:
        return bool(self.columns(table))

    def _max_rowid(self, table: str) -> int:
        row = self.db.execute(f"SELECT MAX(rowid) AS m FROM {table}").fetchone()
        return int(row["m"] or 0)

    def _meta(self, key: str) -> Optional[str]:
        row = self.db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def generation(self) -> str:
        """A random id stamped into this database the first time the relay sees it. A copied database
        keeps it, a replaced or re-created one does not — which is how the agent tells "the user
        deleted things" from "this is a different database now"."""
        gen = self._meta(META_GENERATION)
        if not gen:
            gen = uuid.uuid4().hex
            self.db.execute("BEGIN IMMEDIATE")
            try:
                self._set_meta(META_GENERATION, gen)
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
        return gen

    # ------------------------------------------------------------------ rpc: info
    def hello(self) -> Dict[str, Any]:
        recent = now_ms() - 90_000
        busy_row = self.db.execute("SELECT COUNT(*) AS c FROM events WHERE ts > ?", (recent,)).fetchone()
        running_row = self.db.execute(
            "SELECT COUNT(*) AS c FROM messages WHERE role = 'assistant' AND status IS NULL"
        ).fetchone()
        return {
            "protocol": PROTOCOL,
            "role": self.role,
            "generation": self.generation(),
            "now": now_ms(),
            "events_max_rowid": self._max_rowid("events"),
            "thread_count": self.db.execute("SELECT COUNT(*) AS c FROM threads").fetchone()["c"],
            "event_count": self.db.execute("SELECT COUNT(*) AS c FROM events").fetchone()["c"],
            "recent_events": int(busy_row["c"]),
            "open_assistant_messages": int(running_row["c"]),
        }

    def thread_ids(self) -> List[str]:
        return [r["id"] for r in self.db.execute("SELECT id FROM threads")]

    def thread_versions(self) -> Dict[str, int]:
        return {r["id"]: int(r["updated_at"] or 0) for r in self.db.execute("SELECT id, updated_at FROM threads")}

    def event_counts(self, tids: Optional[List[str]] = None) -> Dict[str, int]:
        if tids is None:
            return {r["thread_id"]: r["c"] for r in self.db.execute("SELECT thread_id, COUNT(*) AS c FROM events GROUP BY thread_id")}
        out: Dict[str, int] = {}
        for tid in tids:
            out[tid] = int(self.db.execute("SELECT COUNT(*) AS c FROM events WHERE thread_id = ?", (tid,)).fetchone()["c"])
        return out

    def message_counts(self) -> Dict[str, int]:
        return {r["thread_id"]: r["c"] for r in self.db.execute("SELECT thread_id, COUNT(*) AS c FROM messages GROUP BY thread_id")}

    # ------------------------------------------------------------------ rpc: export
    def export_lww(self, table: str, since: int, skip: Optional[Dict[str, int]] = None, limit: int = LWW_PAGE) -> Dict[str, Any]:
        """Rows whose timestamp is >= since, oldest first. `skip` maps key -> ts for rows the caller
        already has at exactly that version (the margin window re-reads them every cycle)."""
        if table not in LWW_TABLES or not self.has_table(table):
            return {"rows": [], "more": False, "max_ts": since}
        keys, ts = LWW_TABLES[table]
        skip = skip or {}
        order = ", ".join([ts] + list(keys))
        cur = self.db.execute(f"SELECT * FROM {table} WHERE {ts} >= ? ORDER BY {order} LIMIT ?", (since, limit + len(skip)))
        rows: List[Dict[str, Any]] = []
        max_ts = since
        scanned = 0
        more = False
        for r in cur:
            scanned += 1
            d = dict(r)
            k = _key_str([d[c] for c in keys])
            max_ts = max(max_ts, int(d[ts] or 0))
            if skip.get(k) == d[ts]:
                continue
            rows.append(d)
            if len(rows) >= limit:
                more = True
                break
        return {"rows": rows, "more": more, "max_ts": max_ts}

    def export_events(self, after: int, exclude: Optional[List[List[int]]] = None, limit: int = EVENT_PAGE) -> Dict[str, Any]:
        """Events with rowid > after, skipping rowid ranges this side received by import. The page and
        the high-water mark are read in ONE read transaction: the desktop app appends events between
        statements, and a mark taken from a newer snapshot than the page would skip rows forever."""
        exclude = [r for r in (exclude or []) if r[1] > after]
        clause = ""
        params: List[Any] = [after]
        for lo, hi in exclude:
            clause += " AND NOT (rowid > ? AND rowid <= ?)"
            params += [lo, hi]
        params.append(limit)
        self.db.execute("BEGIN")
        try:
            rows = self.db.execute(
                f"SELECT rowid AS _rowid, * FROM events WHERE rowid > ?{clause} ORDER BY rowid LIMIT ?", params
            ).fetchall()
            visible_max = self._max_rowid("events")
        finally:
            self.db.execute("COMMIT")
        out = [dict(r) for r in rows]
        if len(out) >= limit:
            last = int(out[-1]["_rowid"])
            more = True
        else:
            # Everything visible in this snapshot was scanned (excluded ranges included).
            last = max(after, visible_max)
            more = False
        for d in out:
            d.pop("_rowid", None)
        return {"rows": out, "last_rowid": last, "more": more}

    def watermarks(self) -> Dict[str, Any]:
        """High-water marks for a baseline: max event rowid and each LWW table's max timestamp, read in
        one snapshot. Taken from the byte copy the cloud was seeded from, they are exactly the point
        after which the Mac has rows the cloud does not."""
        self.db.execute("BEGIN")
        try:
            marks: Dict[str, Any] = {"events": self._max_rowid("events"), "lww": {}}
            for table in LWW_ORDER:
                if self.has_table(table):
                    _, ts = LWW_TABLES[table]
                    row = self.db.execute(f"SELECT MAX({ts}) AS m FROM {table}").fetchone()
                    marks["lww"][table] = int(row["m"] or 0)
        finally:
            self.db.execute("COMMIT")
        return marks

    def _thread_row(self, tid: str) -> Optional[Dict[str, Any]]:
        row = self.db.execute("SELECT * FROM threads WHERE id = ?", (tid,)).fetchone()
        return dict(row) if row else None

    def thread_digests(self, tids: List[str]) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        mcols = [c for c in self.columns("messages")]
        for tid in tids:
            t = self._thread_row(tid)
            h = hashlib.sha1()
            if t:
                # cwd is machine-local by design (NULL on the cloud), so it is not part of "the same thread".
                h.update(json.dumps({k: v for k, v in sorted(t.items()) if k != "cwd"}, separators=(",", ":"), default=str).encode())
            n = 0
            for r in self.db.execute(f"SELECT {', '.join(mcols)} FROM messages WHERE thread_id = ? ORDER BY id", (tid,)):
                n += 1
                h.update(json.dumps([r[c] for c in mcols if c in DIGEST_MESSAGE_COLS], separators=(",", ":"), default=str).encode())
            for r in self.db.execute("SELECT name, ord FROM thread_tools WHERE thread_id = ? ORDER BY name", (tid,)):
                h.update(f"tool:{r['name']}:{r['ord']}".encode())
            out[tid] = {
                "exists": t is not None,
                "updated_at": int(t["updated_at"]) if t else 0,
                "messages": n,
                "digest": h.hexdigest(),
            }
        return out

    def export_threads(self, tids: List[str]) -> Dict[str, Dict[str, Any]]:
        out: Dict[str, Dict[str, Any]] = {}
        for tid in tids:
            t = self._thread_row(tid)
            msgs = [dict(r) for r in self.db.execute("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id", (tid,))]
            tools = [dict(r) for r in self.db.execute("SELECT * FROM thread_tools WHERE thread_id = ? ORDER BY ord", (tid,))]
            out[tid] = {"thread": t, "messages": msgs, "thread_tools": tools}
        return out

    def row_ids(self, table: str, thread_id: str, max_rowid: Optional[int] = None) -> List[str]:
        if table not in ("events", "messages"):
            raise ValueError("row_ids only supports events and messages")
        if max_rowid is None:
            q = self.db.execute(f"SELECT id FROM {table} WHERE thread_id = ?", (thread_id,))
        else:
            q = self.db.execute(f"SELECT id FROM {table} WHERE thread_id = ? AND rowid <= ?", (thread_id, max_rowid))
        return [r["id"] for r in q]

    def get_meta(self) -> Dict[str, Any]:
        tokens_raw = self._meta(META_TOKENS)
        try:
            tokens = json.loads(tokens_raw) if tokens_raw else []
        except ValueError:
            tokens = []
        return {"passwordHash": self._meta(META_PASSWORD), "tokens": tokens if isinstance(tokens, list) else []}

    # ------------------------------------------------------------------ rpc: import
    def _upsert_sql(self, table: str, cols: List[str], keys: Sequence[str], update_cols: List[str]) -> str:
        placeholders = ", ".join("?" for _ in cols)
        conflict = ", ".join(keys)
        if update_cols:
            sets = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
            return f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) ON CONFLICT({conflict}) DO UPDATE SET {sets}"
        return f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders}) ON CONFLICT({conflict}) DO NOTHING"

    def import_rows(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        mode: str,
        force: Optional[Dict[str, Any]] = None,
        protect: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """mode: 'append' (insert or ignore), 'lww' (newer timestamp wins), 'replace' (always upsert).
        force: column values applied to every incoming row. protect: columns never overwritten on an
        existing row (still written on insert)."""
        if not rows:
            return {"inserted": 0, "updated": 0, "skipped": 0, "range": None}
        if not self.has_table(table):
            return {"inserted": 0, "updated": 0, "skipped": len(rows), "range": None, "error": f"no table {table}"}
        target_cols = self.columns(table)
        force = force or {}
        protect = set(protect or [])
        if table == "events":
            keys: Tuple[str, ...] = ("id",)
            ts_col = None
        else:
            keys, ts_col = LWW_TABLES[table]
        inserted = updated = skipped = 0
        self.db.execute("BEGIN IMMEDIATE")
        try:
            before = self._max_rowid(table)
            for raw in rows:
                row = {c: raw[c] for c in raw if c in target_cols}
                row.update({c: v for c, v in force.items() if c in target_cols})
                cols = list(row.keys())
                if not all(k in row for k in keys):
                    skipped += 1
                    continue
                where = " AND ".join(f"{k} = ?" for k in keys)
                kv = [row[k] for k in keys]
                if mode == "append":
                    cur = self.db.execute(self._upsert_sql(table, cols, keys, []), [row[c] for c in cols])
                    if cur.rowcount:
                        inserted += 1
                    else:
                        skipped += 1
                    continue
                existing = self.db.execute(f"SELECT * FROM {table} WHERE {where}", kv).fetchone()
                if existing is None:
                    self.db.execute(self._upsert_sql(table, cols, keys, []), [row[c] for c in cols])
                    inserted += 1
                    continue
                if mode == "lww" and ts_col:
                    incoming_ts = int(row.get(ts_col) or 0)
                    current_ts = int(existing[ts_col] or 0)
                    if incoming_ts <= current_ts:
                        skipped += 1
                        continue
                update_cols = [c for c in cols if c not in keys and c not in protect]
                if all(existing[c] == row[c] for c in update_cols):
                    skipped += 1
                    continue
                self.db.execute(self._upsert_sql(table, cols, keys, update_cols), [row[c] for c in cols])
                updated += 1
            after = self._max_rowid(table)
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "range": [before, after] if after > before else None,
        }

    def import_threads(
        self,
        payload: Dict[str, Dict[str, Any]],
        force_thread: Optional[Dict[str, Any]] = None,
        protect_thread: Optional[List[str]] = None,
        authoritative: bool = True,
    ) -> Dict[str, Any]:
        """Copy each thread's messages and tool set from the payload.

        authoritative=True (the payload's side is strictly newer, or the only side that has the
        thread): this side's message set is made to match exactly, deletions included.
        authoritative=False (a tie — both sides changed the thread in the same millisecond, or a
        thread both sides hold at an equal timestamp): a union. Nothing is deleted, and where both
        sides hold the same message the more complete copy wins (finished beats streaming, longer
        beats shorter), so two sides can never overwrite each other back and forth."""
        report = {"threads": 0, "messages_upserted": 0, "messages_deleted": 0, "skipped_newer": 0}
        mcols = self.columns("messages")
        for tid, data in payload.items():
            src_thread = data.get("thread")
            if not src_thread:
                continue
            local = self._thread_row(tid)
            if local and int(local["updated_at"] or 0) > int(src_thread.get("updated_at") or 0):
                report["skipped_newer"] += 1
                continue
            self.import_rows("threads", [src_thread], "lww", force=force_thread, protect=protect_thread)
            incoming = data.get("messages") or []
            incoming_ids = {m["id"] for m in incoming}
            self.db.execute("BEGIN IMMEDIATE")
            try:
                for m in incoming:
                    row = {c: m[c] for c in m if c in mcols}
                    cols = list(row.keys())
                    update_cols = [c for c in cols if c != "id"]
                    existing = self.db.execute("SELECT * FROM messages WHERE id = ?", (row["id"],)).fetchone()
                    if existing is not None:
                        if all(existing[c] == row[c] for c in update_cols):
                            continue
                        if not authoritative and _completeness(dict(existing)) >= _completeness(row):
                            continue
                    self.db.execute(self._upsert_sql("messages", cols, ("id",), update_cols), [row[c] for c in cols])
                    report["messages_upserted"] += 1
                if authoritative:
                    local_ids = [r["id"] for r in self.db.execute("SELECT id FROM messages WHERE thread_id = ?", (tid,))]
                    extra = [i for i in local_ids if i not in incoming_ids]
                    if extra:
                        self.db.executemany("DELETE FROM messages WHERE id = ?", [(i,) for i in extra])
                        report["messages_deleted"] += len(extra)
                    self.db.execute("DELETE FROM thread_tools WHERE thread_id = ?", (tid,))
                for t in data.get("thread_tools") or []:
                    self.db.execute(
                        "INSERT OR REPLACE INTO thread_tools (thread_id, name, ord) VALUES (?, ?, ?)",
                        (tid, t["name"], t["ord"]),
                    )
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            report["threads"] += 1
        return report

    def merge_meta(self, tokens: List[Dict[str, Any]], password_hash: Optional[str] = None) -> Dict[str, Any]:
        current = self.get_meta()
        by_token: Dict[str, Dict[str, Any]] = {}
        for t in current["tokens"] + list(tokens or []):
            tok = t.get("token")
            if not isinstance(tok, str) or not tok:
                continue
            prev = by_token.get(tok)
            if prev is None:
                by_token[tok] = dict(t)
            else:
                prev["lastSeenAt"] = max(int(prev.get("lastSeenAt") or 0), int(t.get("lastSeenAt") or 0))
                prev["expiresAt"] = max(int(prev.get("expiresAt") or 0), int(t.get("expiresAt") or 0))
        now = now_ms()
        merged = sorted((t for t in by_token.values() if int(t.get("expiresAt") or 0) > now), key=lambda t: int(t.get("createdAt") or 0))
        changed = False
        self.db.execute("BEGIN IMMEDIATE")
        try:
            def shape(ts: Iterable[Dict[str, Any]]) -> List[Tuple[str, int]]:
                # lastSeenAt changes on every authenticated request; rewriting meta for that alone would
                # race the app's own token writes every cycle for nothing.
                return sorted((str(t.get("token")), int(t.get("expiresAt") or 0)) for t in ts if int(t.get("expiresAt") or 0) > now)
            if shape(merged) != shape(current["tokens"]):
                self._set_meta(META_TOKENS, json.dumps(merged))
                changed = True
            if password_hash and password_hash != current["passwordHash"]:
                self._set_meta(META_PASSWORD, password_hash)
                changed = True
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"changed": changed, "tokens": len(merged)}

    # ------------------------------------------------------------------ rpc: delete
    def _trash(self, name: str, payload: Any) -> Optional[str]:
        if not self.trash_dir:
            return None
        os.makedirs(self.trash_dir, exist_ok=True)
        path = os.path.join(self.trash_dir, f"{time.strftime('%Y%m%dT%H%M%S')}-{name}.json.gz")
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            json.dump(payload, fh, default=str)
        return path

    def delete_threads(self, tids: List[str], reason: str = "") -> Dict[str, Any]:
        deleted = []
        for tid in tids:
            t = self._thread_row(tid)
            if t is None:
                continue
            payload: Dict[str, Any] = {"reason": reason, "thread": t}
            for table in THREAD_CHILD_TABLES:
                if self.has_table(table):
                    payload[table] = [dict(r) for r in self.db.execute(f"SELECT * FROM {table} WHERE thread_id = ?", (tid,))]
            payload["todos"] = [dict(r) for r in self.db.execute("SELECT * FROM todos WHERE thread_id = ?", (tid,))]
            trash = self._trash(f"thread-{tid}", payload)
            self.db.execute("BEGIN IMMEDIATE")
            try:
                for table in THREAD_CHILD_TABLES:
                    if self.has_table(table):
                        self.db.execute(f"DELETE FROM {table} WHERE thread_id = ?", (tid,))
                self.db.execute("DELETE FROM threads WHERE id = ?", (tid,))
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            deleted.append({"id": tid, "trash": trash})
        return {"deleted": deleted}

    def delete_rows(self, table: str, ids: List[str], reason: str = "") -> Dict[str, Any]:
        if table not in ("events", "messages"):
            raise ValueError("delete_rows only supports events and messages")
        if not ids:
            return {"deleted": 0}
        marks = ",".join("?" for _ in ids)
        rows = [dict(r) for r in self.db.execute(f"SELECT * FROM {table} WHERE id IN ({marks})", ids)]
        self._trash(f"{table}-{len(rows)}", {"reason": reason, "table": table, "rows": rows})
        self.db.execute("BEGIN IMMEDIATE")
        try:
            cur = self.db.execute(f"DELETE FROM {table} WHERE id IN ({marks})", ids)
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"deleted": cur.rowcount}

    def mark_interrupted(self) -> Dict[str, Any]:
        """Assistant replies that were mid-stream on the other runtime when it vanished can never finish
        here; mark them interrupted (exactly what reconcileInterruptedRuns does at app launch)."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            cur = self.db.execute("UPDATE messages SET status = 'interrupted' WHERE role = 'assistant' AND status IS NULL")
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"marked": cur.rowcount}


def _completeness(row: Dict[str, Any]) -> Tuple[int, int, int, int]:
    return (
        1 if row.get("status") is not None else 0,
        len(row.get("text") or ""),
        len(row.get("tool_wire_json") or ""),
        len(row.get("reasoning_content") or ""),
    )


# Message columns that define "the same message" for digest purposes. Deliberately includes the
# streamed text and tool wire, so a reply that is still growing reads as different.
DIGEST_MESSAGE_COLS = {
    "id", "thread_id", "run_id", "role", "created_at", "text", "model", "effort", "status",
    "telemetry_json", "attachments_json", "tool_wire_json", "compacted", "queued", "origin_json",
    "reasoning_content",
}


# ====================================================================== transport
class RemoteError(RuntimeError):
    pass


class RpcSide:
    """Talks to `serve` over a pair of pipes (an SSH session in production, a subprocess in tests)."""

    def __init__(self, proc: Any, name: str) -> None:
        self.proc = proc
        self.name = name
        self._id = 0

    def call(self, method: str, **params: Any) -> Any:
        self._id += 1
        msg = json.dumps({"id": self._id, "method": method, "params": params}, separators=(",", ":"), default=str)
        try:
            self.proc.stdin.write(msg + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        except (BrokenPipeError, OSError) as e:
            raise RemoteError(f"{self.name}: transport closed ({e})")
        if not line:
            raise RemoteError(f"{self.name}: remote closed the session")
        reply = json.loads(line)
        if reply.get("error"):
            raise RemoteError(f"{self.name}.{method}: {reply['error']}")
        return reply.get("result")


class LocalSide:
    def __init__(self, store: Store, name: str) -> None:
        self.store = store
        self.name = name

    def call(self, method: str, **params: Any) -> Any:
        if method not in RPC_METHODS:
            raise RemoteError(f"unknown method {method}")
        # Round-trip through JSON so local and remote sides see identical value types.
        result = getattr(self.store, method)(**json.loads(json.dumps(params, default=str)))
        return json.loads(json.dumps(result, default=str))


def serve(store: Store, stdin: Any = None, stdout: Any = None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            method = req.get("method")
            if method not in RPC_METHODS:
                raise ValueError(f"method not allowed: {method}")
            result = getattr(store, method)(**(req.get("params") or {}))
            out = {"id": req.get("id"), "result": result}
        except Exception as e:  # report, keep serving
            out = {"id": None, "error": f"{type(e).__name__}: {e}"}
            try:
                out["id"] = json.loads(line).get("id")
            except Exception:
                pass
        stdout.write(json.dumps(out, separators=(",", ":"), default=str) + "\n")
        stdout.flush()


# ====================================================================== replication
def empty_state() -> Dict[str, Any]:
    return {
        "version": 1,
        "generations": {},
        "cursors": {"mac": {"events": 0, "lww": {}}, "cloud": {"events": 0, "lww": {}}},
        "exclude": {"mac": [], "cloud": []},
        "sent": {"mac": {}, "cloud": {}},
        "known_threads": [],
        "cycles": 0,
        "last_ok": 0,
        "warnings": [],
    }


def baseline_state(mac: Any, cloud: Any, mac_marks: Dict[str, Any], cloud_marks: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """State for a cloud database that was just seeded from a byte copy of the Mac's. `mac_marks` must be
    the watermarks of that COPY (not of the live Mac database, which has moved on since): every Mac row
    above them is exactly what the cloud is missing. The cloud's marks are its own, taken now."""
    st = empty_state()
    hm, hc = mac.call("hello"), cloud.call("hello")
    st["generations"] = {"mac": hm["generation"], "cloud": hc["generation"]}
    cloud_marks = cloud_marks or cloud.call("watermarks")
    for side, marks in (("mac", mac_marks), ("cloud", cloud_marks)):
        st["cursors"][side]["events"] = int(marks["events"])
        st["cursors"][side]["lww"] = {k: int(v) for k, v in marks["lww"].items()}
    st["known_threads"] = sorted(set(mac.call("thread_ids")) & set(cloud.call("thread_ids")))
    return st


def _warn(state: Dict[str, Any], text: str) -> None:
    entry = {"at": now_ms(), "text": text}
    state.setdefault("warnings", []).append(entry)
    state["warnings"] = state["warnings"][-50:]


def _prune_exclude(ranges: List[List[int]], cursor: int) -> List[List[int]]:
    return [r for r in ranges if r[1] > cursor]


def _thread_force(dst_role: str, cloud_root: str) -> Tuple[Dict[str, Any], List[str]]:
    """cwd is a path on the machine that owns the thread. The container cannot use a Mac path and the
    Mac must never inherit a container path, so: cloud always gets NULL (tools fall back to the
    workspace root), and the Mac never has its cwd overwritten by the cloud."""
    if dst_role == "cloud":
        return {"cwd": None}, []
    return {}, ["cwd"]


def sync_cycle(mac: Any, cloud: Any, state: Dict[str, Any], cloud_root: str = "/var/lib/lattice-cloud/workspace", reconcile: bool = False, log: Any = None) -> Dict[str, Any]:
    """One replication pass. Mutates and returns `state`; returns a report dict under state['last_report']."""
    log = log or (lambda *_: None)
    sides = {"mac": mac, "cloud": cloud}
    hello = {"mac": mac.call("hello"), "cloud": cloud.call("hello")}
    report: Dict[str, Any] = {"started": now_ms(), "events": {}, "lww": {}, "threads": {}, "deleted": {}, "warnings": []}

    # A database that changed identity since the last cycle must be re-baselined, never diffed: its
    # "missing" rows are not deletions.
    gens = state.setdefault("generations", {})
    regenerated = [r for r in ("mac", "cloud") if gens.get(r) and gens[r] != hello[r]["generation"]]
    if regenerated:
        _warn(state, f"database identity changed on {regenerated}; re-baselining without deletions")
        state["known_threads"] = []
        for r in regenerated:
            state["cursors"][r] = {"events": 0, "lww": {}}
            state["exclude"][r] = []
            state["sent"][r] = {}
    for r in ("mac", "cloud"):
        gens[r] = hello[r]["generation"]

    # Thread versions as they were BEFORE this cycle moved anything: once a thread row is copied the two
    # sides agree on its timestamp, and "which side changed it" is exactly what later steps must know.
    pre_versions = {"mac": mac.call("thread_versions"), "cloud": cloud.call("thread_versions")}
    pre_ids = {k: set(v) for k, v in pre_versions.items()}
    touched: set = set()

    # 1. last-writer-wins tables, both directions
    for table in LWW_ORDER:
        for src_name, dst_name in (("mac", "cloud"), ("cloud", "mac")):
            src, dst = sides[src_name], sides[dst_name]
            cur = state["cursors"][src_name]["lww"]
            sent = state["sent"][src_name].setdefault(table, {})
            since = max(0, int(cur.get(table, 0)) - LWW_MARGIN_MS)
            moved = 0
            while True:
                page = src.call("export_lww", table=table, since=since, skip=sent)
                rows = page["rows"]
                if rows:
                    # Thread rows are not written here: a thread row and its messages must move together,
                    # from the side whose row is newer, and copying the row first would erase exactly the
                    # timestamp that decides the direction. Step 5 moves them; this pass only notices them.
                    if table != "threads":
                        res = dst.call("import_rows", table=table, rows=rows, mode="lww")
                        moved += res["inserted"] + res["updated"]
                    keys, ts = LWW_TABLES[table]
                    for row in rows:
                        sent[_key_str([row[k] for k in keys])] = row[ts]
                        if table == "threads":
                            touched.add(row["id"])
                cur[table] = max(int(cur.get(table, 0)), int(page["max_ts"]))
                if not page["more"]:
                    break
                since = int(page["max_ts"])
            # forget dedupe entries that fell out of the margin window
            floor = int(cur.get(table, 0)) - LWW_MARGIN_MS
            state["sent"][src_name][table] = {k: v for k, v in sent.items() if int(v or 0) >= floor}
            if moved:
                report["lww"][f"{table}:{src_name}->{dst_name}"] = moved

    # 2. workspaces: Mac -> cloud, roots rewritten (the container's tools must run somewhere real)
    ws = mac.call("export_lww", table="workspaces", since=0, skip={}, limit=100)["rows"]
    if ws:
        cloud.call("import_rows", table="workspaces", rows=ws, mode="replace", force={"roots_json": json.dumps([cloud_root])})

    # 3. events, both directions, with echo suppression by imported rowid range
    for src_name, dst_name in (("mac", "cloud"), ("cloud", "mac")):
        src, dst = sides[src_name], sides[dst_name]
        cursor = int(state["cursors"][src_name]["events"])
        moved = 0
        while True:
            page = src.call("export_events", after=cursor, exclude=state["exclude"][src_name])
            rows = page["rows"]
            if rows:
                res = dst.call("import_rows", table="events", rows=rows, mode="append")
                moved += res["inserted"]
                if res.get("range"):
                    state["exclude"][dst_name].append(res["range"])
                for row in rows:
                    touched.add(row["thread_id"])
            cursor = max(cursor, int(page["last_rowid"]))
            if not page["more"]:
                break
        state["cursors"][src_name]["events"] = cursor
        state["exclude"][src_name] = _prune_exclude(state["exclude"][src_name], cursor)
        if moved:
            report["events"][f"{src_name}->{dst_name}"] = moved

    # 4. threads created on one side only are touched too (their messages must follow)
    touched |= pre_ids["mac"] ^ pre_ids["cloud"]

    # 5. touched threads: copy messages + tool sets where digests differ
    if touched:
        tids = sorted(touched)
        known_before = set(state.get("known_threads") or [])
        for i in range(0, len(tids), 50):
            chunk = tids[i:i + 50]
            dm = mac.call("thread_digests", tids=chunk)
            dc = cloud.call("thread_digests", tids=chunk)
            plan: Dict[Tuple[str, bool], List[str]] = {}
            for tid in chunk:
                a, b = dm[tid], dc[tid]
                if a["exists"] and b["exists"] and a["digest"] == b["digest"]:
                    continue
                if not a["exists"] and not b["exists"]:
                    continue
                if tid in known_before and not (a["exists"] and b["exists"]):
                    continue  # a deletion on one side; step 7 decides
                # Who owns the difference: the side that had the thread before this cycle, else the
                # side whose thread row is strictly newer. Equal timestamps are a tie -> union both ways.
                if tid in pre_ids["mac"] and tid not in pre_ids["cloud"]:
                    plan.setdefault(("cloud", True), []).append(tid)
                elif tid in pre_ids["cloud"] and tid not in pre_ids["mac"]:
                    plan.setdefault(("mac", True), []).append(tid)
                elif a["updated_at"] > b["updated_at"]:
                    plan.setdefault(("cloud", True), []).append(tid)
                elif b["updated_at"] > a["updated_at"]:
                    plan.setdefault(("mac", True), []).append(tid)
                else:
                    plan.setdefault(("cloud", False), []).append(tid)
                    plan.setdefault(("mac", False), []).append(tid)
            for (dst_name, authoritative), group in sorted(plan.items(), key=lambda kv: (not kv[0][1], kv[0][0])):
                src = mac if dst_name == "cloud" else cloud
                dst = sides[dst_name]
                force, protect = _thread_force(dst_name, cloud_root)
                r = dst.call(
                    "import_threads",
                    payload=src.call("export_threads", tids=group),
                    force_thread=force,
                    protect_thread=protect,
                    authoritative=authoritative,
                )
                label = ("mac->cloud" if dst_name == "cloud" else "cloud->mac") + ("" if authoritative else " (union)")
                report["threads"][label] = report["threads"].get(label, 0) + r["threads"]

    # 6. device tokens (both ways) + password hash (Mac -> cloud)
    mm, mc = mac.call("get_meta"), cloud.call("get_meta")
    cloud.call("merge_meta", tokens=mm["tokens"], password_hash=mm["passwordHash"])
    mac.call("merge_meta", tokens=mc["tokens"], password_hash=None)

    # 7. thread deletions
    known = set(state.get("known_threads") or [])
    post_ids = {"mac": set(mac.call("thread_ids")), "cloud": set(cloud.call("thread_ids"))}
    gone_mac = sorted((known - post_ids["mac"]) & post_ids["cloud"])
    gone_cloud = sorted((known - post_ids["cloud"]) & post_ids["mac"])
    for gone, target_name, origin in ((gone_mac, "cloud", "mac"), (gone_cloud, "mac", "cloud")):
        if not gone:
            continue
        if len(gone) > MAX_THREAD_DELETES_PER_CYCLE:
            msg = f"{len(gone)} threads vanished from {origin} in one cycle (> {MAX_THREAD_DELETES_PER_CYCLE}); not propagating"
            _warn(state, msg)
            report["warnings"].append(msg)
            continue
        res = sides[target_name].call("delete_threads", tids=gone, reason=f"deleted on {origin}")
        report["deleted"][f"threads:{origin}->{target_name}"] = len(res["deleted"])
        for tid in gone:
            post_ids[target_name].discard(tid)

    # 8. per-thread event deletions (clear thread, retried turns), bounded. Touched threads every cycle —
    # the cycle that sees a clear is the only one that still knows which side made it — and every
    # shared thread when a full reconcile is asked for.
    scope = sorted(set(state.get("known_threads") or []) if reconcile else (touched & set(state.get("known_threads") or [])))
    if scope:
        _reconcile_rows(mac, cloud, state, report, pre_versions, scope)

    state["known_threads"] = sorted(post_ids["mac"] & post_ids["cloud"])
    state["cycles"] = int(state.get("cycles", 0)) + 1
    state["last_ok"] = now_ms()
    report["finished"] = now_ms()
    report["hello"] = {k: {kk: v[kk] for kk in ("thread_count", "event_count", "recent_events", "open_assistant_messages")} for k, v in hello.items()}
    state["last_report"] = report
    return report


def _reconcile_rows(mac: Any, cloud: Any, state: Dict[str, Any], report: Dict[str, Any], pre_versions: Dict[str, Dict[str, int]], scope: List[str]) -> None:
    full = len(scope) > 200
    counts = {
        "mac": mac.call("event_counts") if full else mac.call("event_counts", tids=scope),
        "cloud": cloud.call("event_counts") if full else cloud.call("event_counts", tids=scope),
    }
    sides = {"mac": mac, "cloud": cloud}
    mismatched = sorted(t for t in scope if counts["mac"].get(t, 0) != counts["cloud"].get(t, 0))
    if not mismatched:
        return
    cursors = {"mac": int(state["cursors"]["mac"]["events"]), "cloud": int(state["cursors"]["cloud"]["events"])}
    for tid in mismatched:
        ids_all = {
            "mac": set(mac.call("row_ids", table="events", thread_id=tid)),
            "cloud": set(cloud.call("row_ids", table="events", thread_id=tid)),
        }
        for side, other in (("mac", "cloud"), ("cloud", "mac")):
            if state["exclude"][side]:
                continue  # this side still has import ranges above its cursor; decide next cycle
            # Rows this side held before its export cursor that the other side no longer has were deleted
            # over there. (Rows received by import this cycle sit above the cursor, so they are never here.)
            old = set(sides[side].call("row_ids", table="events", thread_id=tid, max_rowid=cursors[side]))
            candidates = sorted(old - ids_all[other])
            if not candidates:
                continue
            other_newer = pre_versions[other].get(tid, 0) > pre_versions[side].get(tid, 0)
            total = max(1, len(ids_all[side]))
            too_many = len(candidates) > MAX_ROW_DELETES_PER_THREAD or (len(candidates) > 20 and len(candidates) / total > MAX_ROW_DELETE_FRACTION)
            # A clear/retry bumps the thread's updated_at where it happened, so a large deletion is only
            # trusted when it comes from the side whose thread row is newer.
            if too_many and not other_newer:
                msg = f"thread {tid}: {len(candidates)} events missing on {other}, which is not newer; not propagating"
                _warn(state, msg)
                report["warnings"].append(msg)
                continue
            res = sides[side].call("delete_rows", table="events", ids=candidates, reason=f"deleted on {other}")
            report["deleted"][f"events:{other}->{side}:{tid}"] = res["deleted"]


# ====================================================================== cli
def _cmd_prepare_cloud(args: argparse.Namespace) -> None:
    """Turn a byte copy of the Mac database into the cloud's database: keep threads/meta, drop the
    Mac-only runtime configuration the container cannot use (MCP servers, model cache), point the
    workspace at the container, and write the cloud's provider list."""
    db = sqlite3.connect(args.db, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("BEGIN IMMEDIATE")
    db.execute("DELETE FROM mcp_servers")
    db.execute("DELETE FROM model_cache")
    db.execute("DELETE FROM session_messages")
    db.execute("UPDATE workspaces SET roots_json = ?", (json.dumps([args.cloud_root]),))
    db.execute("UPDATE threads SET cwd = NULL")
    row = db.execute("SELECT value_json FROM settings WHERE key = 'app'").fetchone()
    settings = json.loads(row["value_json"]) if row else {}
    providers = json.loads(args.providers_json) if args.providers_json else settings.get("providers", [])
    settings["providers"] = providers
    if args.default_model:
        settings["defaultModel"] = args.default_model
    ra = settings.get("remoteAccess") or {}
    ra.update({"enabled": True, "port": args.port})
    settings["remoteAccess"] = ra
    db.execute(
        "INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        (json.dumps(settings),),
    )
    # A fresh identity: this is now a different database from the Mac's, and the agent must know.
    db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (META_GENERATION, uuid.uuid4().hex))
    db.execute("COMMIT")
    db.close()
    print(json.dumps({"ok": True, "db": args.db}))


def _cmd_backup(args: argparse.Namespace) -> None:
    src = sqlite3.connect(args.db, timeout=30)
    dst = sqlite3.connect(args.out)
    with dst:
        src.backup(dst, pages=4096)
    dst.close()
    src.close()
    print(json.dumps({"ok": True, "out": args.out, "bytes": os.path.getsize(args.out)}))


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="lattice_relay_sync")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="JSON-RPC over stdin/stdout for one database")
    s.add_argument("--db", required=True)
    s.add_argument("--role", required=True, choices=["mac", "cloud"])
    s.add_argument("--trash")
    i = sub.add_parser("info")
    i.add_argument("--db", required=True)
    i.add_argument("--role", default="cloud", choices=["mac", "cloud"])
    b = sub.add_parser("backup")
    b.add_argument("--db", required=True)
    b.add_argument("--out", required=True)
    m = sub.add_parser("mark-interrupted")
    m.add_argument("--db", required=True)
    pc = sub.add_parser("prepare-cloud")
    pc.add_argument("--db", required=True)
    pc.add_argument("--cloud-root", default="/var/lib/lattice-cloud/workspace")
    pc.add_argument("--providers-json", default="")
    pc.add_argument("--default-model", default="")
    pc.add_argument("--port", type=int, default=8975)
    args = p.parse_args(argv)
    if args.cmd == "serve":
        serve(Store(args.db, args.role, trash_dir=args.trash))
    elif args.cmd == "info":
        print(json.dumps(Store(args.db, args.role).hello(), indent=2))
    elif args.cmd == "backup":
        _cmd_backup(args)
    elif args.cmd == "mark-interrupted":
        print(json.dumps(Store(args.db, "cloud").mark_interrupted()))
    elif args.cmd == "prepare-cloud":
        _cmd_prepare_cloud(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
