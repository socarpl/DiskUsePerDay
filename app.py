"""DiskUsePerDay - visualize how much data was created each day in a folder tree."""
import os
import subprocess
import sys

from flask import Flask, jsonify, request, send_from_directory, make_response, render_template

import scanner
from report import REPORT_ORDERS, directory_key, report_rows
from datetime import datetime

app = Flask(__name__, static_folder="static", static_url_path="")

scanner.init_db()


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/scan", methods=["POST"])
def start_scan():
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip().strip('"')
    if not path:
        return jsonify({"error": "Path is required"}), 400
    if not os.path.isdir(path):
        return jsonify({"error": "Path does not exist or is not a directory"}), 400
    root = os.path.abspath(path)
    started = scanner.scan_folder(root)
    if not started:
        return jsonify({"error": "A scan is already running"}), 409
    return jsonify({"status": "started", "root": root})


@app.route("/api/scan/status")
def scan_status():
    return jsonify(scanner.get_status())


@app.route("/api/roots")
def roots():
    conn = scanner.get_db()
    rows = conn.execute(
        "SELECT root, last_scanned, file_count, total_size FROM scans ORDER BY last_scanned DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/roots", methods=["DELETE"])
def delete_root():
    root = (request.args.get("root") or "").strip()
    if not root:
        return jsonify({"error": "root is required"}), 400
    conn = scanner.get_db()
    conn.execute("DELETE FROM files WHERE root = ?", (root,))
    conn.execute("DELETE FROM scans WHERE root = ?", (root,))
    conn.commit()
    conn.close()
    return jsonify({"status": "deleted"})


@app.route("/api/years")
def years():
    root = request.args.get("root")
    if not root:
        return jsonify({"error": "root is required"}), 400
    conn = scanner.get_db()
    rows = conn.execute(
        "SELECT substr(created_at,1,4) AS year, SUM(size) AS total_size, COUNT(*) AS file_count "
        "FROM files WHERE root=? GROUP BY year ORDER BY year",
        (root,),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/months")
def months():
    root = request.args.get("root")
    year = request.args.get("year")
    if not root or not year:
        return jsonify({"error": "root and year are required"}), 400
    conn = scanner.get_db()
    rows = conn.execute(
        "SELECT substr(created_at,6,2) AS month, SUM(size) AS total_size, COUNT(*) AS file_count "
        "FROM files WHERE root=? AND substr(created_at,1,4)=? GROUP BY month ORDER BY month",
        (root, year),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/days")
def days():
    root = request.args.get("root")
    year = request.args.get("year")
    month = request.args.get("month")
    if not root or not year or not month:
        return jsonify({"error": "root, year and month are required"}), 400
    conn = scanner.get_db()
    rows = conn.execute(
        "SELECT created_at AS date, SUM(size) AS total_size, COUNT(*) AS file_count "
        "FROM files WHERE root=? AND substr(created_at,1,4)=? AND substr(created_at,6,2)=? "
        "GROUP BY created_at ORDER BY created_at",
        (root, year, month),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


SORT_COLUMNS = {"name": "name", "path": "path", "size": "size", "created_at": "created_at"}
MAX_PAGE_SIZE = 100


def file_filters(args):
    """Shared filters for the paginated list and its complete export."""
    root, year = args.get("root"), args.get("year")
    month, day = args.get("month"), args.get("day")
    query = (args.get("q") or "").strip()
    conditions = ["root = ?", "substr(created_at,1,4) = ?"]
    params = [root, year]
    if month:
        conditions.append("substr(created_at,6,2) = ?")
        params.append(month)
    if day:
        conditions.append("created_at = ?")
        params.append(f"{year}-{month}-{day}")
    if query:
        conditions.append("(name LIKE ? OR path LIKE ?)")
        like = f"%{query}%"
        params.extend([like, like])
    return " AND ".join(conditions), params



@app.route("/api/files")
def files():
    root = request.args.get("root")
    year = request.args.get("year")
    month = request.args.get("month")
    day = request.args.get("day")
    query = (request.args.get("q") or "").strip()
    sort = SORT_COLUMNS.get(request.args.get("sort", "size"), "size")
    order = "ASC" if request.args.get("order", "desc").lower() == "asc" else "DESC"

    if not root or not year:
        return jsonify({"error": "root and year are required (month/day optional)"}), 400

    try:
        page = max(1, int(request.args.get("page", 1)))
    except ValueError:
        page = 1
    try:
        page_size = int(request.args.get("page_size", MAX_PAGE_SIZE))
    except ValueError:
        page_size = MAX_PAGE_SIZE
    page_size = max(1, min(page_size, MAX_PAGE_SIZE))

    where_clause, params = file_filters(request.args)

    conn = scanner.get_db()
    total = conn.execute(f"SELECT COUNT(*) AS c FROM files WHERE {where_clause}", params).fetchone()["c"]
    offset = (page - 1) * page_size
    rows = conn.execute(
        f"SELECT path, name, size, created_at FROM files WHERE {where_clause} "
        f"ORDER BY {sort} {order} LIMIT ? OFFSET ?",
        (*params, page_size, offset),
    ).fetchall()
    conn.close()

    return jsonify(
        {
            "files": [dict(r) for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, -(-total // page_size)),
        }
    )


@app.route("/api/files/export")
def export_files():
    if not request.args.get("root") or not request.args.get("year"):
        return jsonify({"error": "root and year are required"}), 400
    mode = request.args.get("organization", "size_desc")
    if mode not in REPORT_ORDERS:
        return jsonify({"error": "Unknown report organization"}), 400
    where_clause, params = file_filters(request.args)
    conn = scanner.get_db()
    try:
        conn.create_collation("DIRECTORY_TREE", lambda a, b:
            (directory_key(a) > directory_key(b)) - (directory_key(a) < directory_key(b)))
        rows = conn.execute(
            f"SELECT path, name, size, created_at FROM files WHERE {where_clause} "
            f"ORDER BY {REPORT_ORDERS[mode][1]}", params,
        ).fetchall()
    finally:
        conn.close()
    period = "-".join(request.args[key] for key in ("year", "month", "day") if request.args.get(key))
    html = render_template(
        "report.html", root=request.args["root"], period=period,
        query=(request.args.get("q") or "").strip(), organization=REPORT_ORDERS[mode][0],
        generated=datetime.now().astimezone().isoformat(timespec="seconds"),
        count=len(rows), total_size=sum(row["size"] for row in rows),
        rows=report_rows(rows, mode == "tree"),
    )
    response = make_response(html)
    response.headers["Content-Disposition"] = 'attachment; filename="DiskUsePerDay-report.html"'
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/open", methods=["POST"])
def open_path():
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    action = data.get("action")
    if action not in ("file", "folder"):
        return jsonify({"error": "action must be 'file' or 'folder'"}), 400
    if not path:
        return jsonify({"error": "path is required"}), 400

    # Only allow opening paths that came from an actual scan, not arbitrary input.
    conn = scanner.get_db()
    known = conn.execute("SELECT 1 FROM files WHERE path=? LIMIT 1", (path,)).fetchone()
    conn.close()
    if not known:
        return jsonify({"error": "Unknown file path"}), 400
    if not os.path.exists(path):
        return jsonify({"error": "File no longer exists on disk"}), 404

    try:
        if sys.platform == "win32":
            if action == "file":
                os.startfile(path)  # noqa: S606 - path validated against scanned files above
            else:
                subprocess.run(["explorer", "/select,", os.path.normpath(path)], check=False)
        elif sys.platform == "darwin":
            subprocess.run(["open", path] if action == "file" else ["open", "-R", path], check=False)
        else:
            target = path if action == "file" else os.path.dirname(path)
            subprocess.run(["xdg-open", target], check=False)
    except OSError as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({"status": "ok"})


if __name__ == "__main__":
    # Bind to localhost only: this tool reads arbitrary local file paths, never expose it publicly.
    app.run(host="127.0.0.1", port=5000, debug=False)
