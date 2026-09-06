"""Folder scanning and SQLite storage for DiskUsePerDay."""
import os
import sqlite3
import threading
import time
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "diskuse.db")

_scan_lock = threading.Lock()
_scan_status = {
    "running": False,
    "root": None,
    "scanned": 0,
    "total_size": 0,
    "error": None,
    "done": False,
}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            created_ts REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_files_root_date ON files(root, created_at)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS scans (
            root TEXT PRIMARY KEY,
            last_scanned TEXT NOT NULL,
            file_count INTEGER NOT NULL,
            total_size INTEGER NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def get_status():
    with _scan_lock:
        return dict(_scan_status)


def scan_folder(root):
    """Kick off a background scan of `root`. Returns False if a scan is already running."""
    with _scan_lock:
        if _scan_status["running"]:
            return False
        _scan_status.update(
            {"running": True, "root": root, "scanned": 0, "total_size": 0, "error": None, "done": False}
        )

    def worker():
        conn = get_db()
        try:
            conn.execute("DELETE FROM files WHERE root = ?", (root,))
            conn.commit()
            count = 0
            total_size = 0
            batch = []
            for dirpath, _dirnames, filenames in os.walk(root):
                for fname in filenames:
                    fpath = os.path.join(dirpath, fname)
                    try:
                        st = os.stat(fpath)
                    except OSError:
                        continue
                    size = st.st_size
                    ts = st.st_ctime
                    date_str = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
                    batch.append((root, fpath, fname, size, date_str, ts))
                    count += 1
                    total_size += size
                    if len(batch) >= 500:
                        conn.executemany(
                            "INSERT INTO files (root, path, name, size, created_at, created_ts) "
                            "VALUES (?,?,?,?,?,?)",
                            batch,
                        )
                        conn.commit()
                        batch = []
                        with _scan_lock:
                            _scan_status["scanned"] = count
                            _scan_status["total_size"] = total_size
            if batch:
                conn.executemany(
                    "INSERT INTO files (root, path, name, size, created_at, created_ts) VALUES (?,?,?,?,?,?)",
                    batch,
                )
                conn.commit()
            conn.execute(
                "INSERT INTO scans (root, last_scanned, file_count, total_size) VALUES (?,?,?,?) "
                "ON CONFLICT(root) DO UPDATE SET last_scanned=excluded.last_scanned, "
                "file_count=excluded.file_count, total_size=excluded.total_size",
                (root, datetime.now().isoformat(timespec="seconds"), count, total_size),
            )
            conn.commit()
            with _scan_lock:
                _scan_status.update(
                    {"scanned": count, "total_size": total_size, "running": False, "done": True}
                )
        except Exception as exc:  # keep worker thread from dying silently
            with _scan_lock:
                _scan_status.update({"running": False, "error": str(exc), "done": True})
        finally:
            conn.close()

    threading.Thread(target=worker, daemon=True).start()
    return True
