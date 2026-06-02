#!/usr/bin/env python3
"""
The Devine Estimator -- backend server (Python standard library only).

Run:  python3 server.py [--host 0.0.0.0] [--port 8000]
Then open http://<server-ip>/ (or :80) in a browser.

No third-party packages required. No authentication (per spec).
"""
import argparse
import csv
import io
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
PROJECTS_DIR = os.path.join(HERE, "projects")
CONFIG_PATH = os.path.join(HERE, "config.json")
SESSION_PATH = os.path.join(HERE, "session.json")   # persists last-open project

os.makedirs(PROJECTS_DIR, exist_ok=True)
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


# --------------------------------------------------------------------------- #
#  Session (last open project — survives browser refresh)
# --------------------------------------------------------------------------- #
_session_lock = threading.Lock()

def load_session():
    with _session_lock:
        try:
            if os.path.exists(SESSION_PATH):
                with open(SESSION_PATH, "r", encoding="utf-8") as fh:
                    return json.load(fh)
        except Exception:
            pass
    return {}

def save_session(data):
    with _session_lock:
        try:
            with open(SESSION_PATH, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
        except Exception as exc:
            print("WARN: could not save session:", exc)

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
PROJECTS_DIR = os.path.join(HERE, "projects")
CONFIG_PATH = os.path.join(HERE, "config.json")

os.makedirs(PROJECTS_DIR, exist_ok=True)
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")

# Default DB path — always relative to server.py location.
# Stored as a relative path in config.json so it works on any machine.
DEFAULT_DB_RELPATH = os.path.join("data", "parts.db")

DEFAULT_CONFIG = {
    "dbPath": os.path.join(HERE, DEFAULT_DB_RELPATH),
    "table": "parts",
    "columns": {
        "part_no": "part_no",
        "description": "description",
        "unit": "unit",
        "cost": "cost",
        "retail": "retail",
        "category": "category",
        "labour": "labour",
    },
}

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_csv_cache = {}            # path -> (mtime, sqlite_connection)
_csv_lock = threading.Lock()


def _resolve_db_path(raw):
    """Turn a stored path into an absolute path.
    If it's already absolute and exists, use it.
    If it's relative (or absolute but missing), try resolving relative to HERE.
    This means config.json can store just 'data/parts.db' and it always works."""
    if not raw:
        return os.path.join(HERE, DEFAULT_DB_RELPATH)
    if os.path.isabs(raw):
        if os.path.exists(raw):
            return raw
        # Absolute path doesn't exist on this machine — try as relative to HERE
        basename = raw.replace("\\", "/").rstrip("/")
        # Extract the last two components (e.g. data/parts.db)
        parts = basename.split("/")
        for n in range(min(3, len(parts)), 0, -1):
            candidate = os.path.join(HERE, *parts[-n:])
            if os.path.exists(candidate):
                return candidate
        # Fall back: treat whole thing as relative to HERE
        return os.path.join(HERE, os.path.basename(raw))
    # Relative path — resolve against HERE
    return os.path.join(HERE, raw)


# --------------------------------------------------------------------------- #
#  Config
# --------------------------------------------------------------------------- #
def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                saved = json.load(fh)
            raw_path = saved.get("dbPath", "")
            cfg["dbPath"] = _resolve_db_path(raw_path) if raw_path else cfg["dbPath"]
            cfg["table"] = saved.get("table", cfg["table"])
            if isinstance(saved.get("columns"), dict):
                cfg["columns"].update(saved["columns"])
        except Exception as exc:  # noqa: BLE001
            print("WARN: could not read config.json:", exc)
    return cfg


def save_config(cfg):
    # Store dbPath as relative to HERE when possible, so config is portable
    saveable = json.loads(json.dumps(cfg))
    db = saveable.get("dbPath", "")
    try:
        rel = os.path.relpath(db, HERE)
        # Only store as relative if it doesn't go outside HERE (no leading ../..)
        if not rel.startswith(".."):
            saveable["dbPath"] = rel.replace("\\", "/")
    except ValueError:
        pass  # Different drive on Windows — keep absolute
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(saveable, fh, indent=2)


# --------------------------------------------------------------------------- #
#  Parts data source (SQLite file or CSV)
# --------------------------------------------------------------------------- #
def _csv_to_memory_db(path):
    """Load a CSV file into an in-memory sqlite db (table 'parts')."""
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        rows = list(reader)
    if not rows:
        raise ValueError("CSV file is empty")
    header = rows[0]
    safe_cols = []
    for i, h in enumerate(header):
        h = h.strip()
        if not _IDENT_RE.match(h):
            h = "col%d" % i
        safe_cols.append(h)
    con = sqlite3.connect(":memory:", check_same_thread=False)
    coldef = ", ".join('"%s" TEXT' % c for c in safe_cols)
    con.execute('CREATE TABLE parts (%s)' % coldef)
    placeholders = ",".join("?" * len(safe_cols))
    for r in rows[1:]:
        r = (r + [None] * len(safe_cols))[: len(safe_cols)]
        con.execute("INSERT INTO parts VALUES (%s)" % placeholders, r)
    con.commit()
    return con


_sqlite_cache    = {}   # path -> connection
_sqlite_lock     = threading.Lock()
_validate_cache  = {}   # (con_id, table) -> frozenset of column names
_index_cache     = set() # (con_id, table) already indexed


def get_connection(cfg):
    """Return (connection, effective_table). Supports .csv and sqlite files."""
    path = cfg["dbPath"]
    if not path or not os.path.exists(path):
        raise FileNotFoundError("Database not found: %s" % path)
    if path.lower().endswith(".csv"):
        mtime = os.path.getmtime(path)
        with _csv_lock:
            cached = _csv_cache.get(path)
            if not cached or cached[0] != mtime:
                con = _csv_to_memory_db(path)
                _csv_cache[path] = (mtime, con)
            else:
                con = cached[1]
        return con, "parts"
    with _sqlite_lock:
        if path not in _sqlite_cache:
            _sqlite_cache[path] = sqlite3.connect(path, check_same_thread=False)
        con = _sqlite_cache[path]
    return con, cfg["table"]


def _validate_identifiers(con, table, columns):
    """Ensure table + mapped columns exist. Result is cached per connection."""
    key = (id(con), table)
    if key in _validate_cache:
        return _validate_cache[key]
    if not _IDENT_RE.match(table):
        raise ValueError("Invalid table name: %s" % table)
    have = {row[1] for row in con.execute('PRAGMA table_info("%s")' % table)}
    if not have:
        raise ValueError("Table '%s' not found in database" % table)
    for k, col in columns.items():
        if col and col not in have:
            raise ValueError(
                "Column '%s' (mapped as %s) not in table '%s'. Available: %s"
                % (col, k, table, ", ".join(sorted(have)))
            )
    _validate_cache[key] = have
    return have


def _ensure_parts_indexes(con, table, cols):
    """Create indexes on searchable columns once per connection."""
    key = (id(con), table)
    if key in _index_cache:
        return
    _index_cache.add(key)
    try:
        for k in ("part_no", "description", "category"):
            col = cols.get(k)
            if col:
                con.execute(
                    'CREATE INDEX IF NOT EXISTS "idx_%s_%s" ON "%s"("%s")'
                    % (table, col, table, col)
                )
        con.commit()
    except Exception:
        pass


def query_parts(cfg, search="", limit=100):
    con, table = get_connection(cfg)
    cols = cfg["columns"]
    _validate_identifiers(con, table, cols)
    _ensure_parts_indexes(con, table, cols)

    def sel(key):
        c = cols.get(key)
        return '"%s" AS %s' % (c, key) if c else "NULL AS %s" % key

    select_cols = ", ".join(
        sel(k) for k in ("part_no", "description", "unit", "cost", "retail", "category", "labour")
    )
    sql = 'SELECT %s FROM "%s"' % (select_cols, table)
    params = []
    if search:
        like = "%" + search + "%"
        conds = []
        for k in ("part_no", "description", "category"):
            if cols.get(k):
                conds.append('"%s" LIKE ?' % cols[k])
                params.append(like)
        if conds:
            sql += " WHERE " + " OR ".join(conds)
    sql += " ORDER BY \"%s\"" % cols.get("part_no", "part_no")
    sql += " LIMIT ?"
    params.append(int(limit))
    cur  = con.execute(sql, params)
    rows = cur.fetchall()
    desc = [d[0] for d in cur.description]
    out = []
    for r in rows:
        item = dict(zip(desc, r))
        for money in ("cost", "retail", "labour"):
            try:
                item[money] = float(item[money]) if item[money] not in (None, "") else 0.0
            except (TypeError, ValueError):
                item[money] = 0.0
        out.append(item)
    return out


# --------------------------------------------------------------------------- #
#  Projects (one JSON file per project)
# --------------------------------------------------------------------------- #
_SAFE_NAME = re.compile(r"[^A-Za-z0-9 _\-().]+")


def safe_project_name(name):
    name = (name or "").strip()
    name = _SAFE_NAME.sub("_", name)
    return name[:120] or "untitled"


def project_path(name):
    return os.path.join(PROJECTS_DIR, safe_project_name(name) + ".json")


def list_projects():
    out = []
    for fn in sorted(os.listdir(PROJECTS_DIR)):
        if fn.endswith(".json"):
            full = os.path.join(PROJECTS_DIR, fn)
            out.append(
                {
                    "name": fn[:-5],
                    "modified": os.path.getmtime(full),
                    "size": os.path.getsize(full),
                }
            )
    return out


# --------------------------------------------------------------------------- #
#  Package store — separate 'packages' table in the parts SQLite DB
#  Schema: part_no TEXT PK, description TEXT, category TEXT,
#          cost REAL, retail REAL, components TEXT (JSON array)
# --------------------------------------------------------------------------- #

def _pkg_con():
    """Return a connection to the parts DB, ensuring the packages table exists."""
    cfg = load_config()
    con, _ = get_connection(cfg)
    con.execute(
        "CREATE TABLE IF NOT EXISTS packages ("
        "part_no TEXT PRIMARY KEY, description TEXT, category TEXT,"
        " cost REAL, retail REAL, components TEXT)"
    )
    con.commit()
    return con

def db_load_packages():
    con = _pkg_con()
    rows = con.execute(
        "SELECT part_no, description, category, cost, retail, components FROM packages"
    ).fetchall()
    out = []
    for r in rows:
        try:
            comps = json.loads(r[5]) if r[5] else []
        except Exception:
            comps = []
        out.append({"part_no": r[0], "description": r[1], "category": r[2],
                    "cost": r[3] or 0, "retail": r[4] or 0,
                    "components": comps, "isPackage": True, "_custom": True, "unit": "ea"})
    return out

def db_upsert_package(pkg):
    con = _pkg_con()
    con.execute(
        "INSERT OR REPLACE INTO packages (part_no, description, category, cost, retail, components)"
        " VALUES (?,?,?,?,?,?)",
        [pkg.get("part_no",""), pkg.get("description",""), pkg.get("category","packages"),
         float(pkg.get("cost",0) or 0), float(pkg.get("retail",0) or 0),
         json.dumps(pkg.get("components", []))]
    )
    con.commit()

def db_delete_package(part_no):
    con = _pkg_con()
    con.execute("DELETE FROM packages WHERE part_no=?", [part_no])
    con.commit()


# --------------------------------------------------------------------------- #
#  Symbol store — 'symbols' table in the parts SQLite DB
#  Schema: id TEXT PK, name TEXT, category TEXT, data_url TEXT
# --------------------------------------------------------------------------- #

def _sym_con():
    cfg = load_config()
    con, _ = get_connection(cfg)
    con.execute(
        "CREATE TABLE IF NOT EXISTS symbols ("
        "id TEXT PRIMARY KEY, name TEXT, category TEXT, data_url TEXT)"
    )
    cols = {r[1] for r in con.execute("PRAGMA table_info(symbols)").fetchall()}
    if "width_mm"    not in cols: con.execute("ALTER TABLE symbols ADD COLUMN width_mm REAL")
    if "height_mm"   not in cols: con.execute("ALTER TABLE symbols ADD COLUMN height_mm REAL")
    if "shapes_json" not in cols: con.execute("ALTER TABLE symbols ADD COLUMN shapes_json TEXT")
    con.commit()
    return con

def db_load_symbols():
    con = _sym_con()
    rows = con.execute(
        "SELECT id, name, category, data_url, width_mm, height_mm, shapes_json FROM symbols"
    ).fetchall()
    result = []
    for r in rows:
        sym = {"id": r[0], "name": r[1], "category": r[2] or "custom",
               "dataURL": r[3] or "", "custom": True}
        if r[4] is not None: sym["widthMm"]    = r[4]
        if r[5] is not None: sym["heightMm"]   = r[5]
        if r[6]:             sym["shapesJson"] = r[6]
        result.append(sym)
    return result

def db_upsert_symbol(sym):
    con = _sym_con()
    con.execute(
        "INSERT OR REPLACE INTO symbols "
        "(id, name, category, data_url, width_mm, height_mm, shapes_json) "
        "VALUES (?,?,?,?,?,?,?)",
        [sym.get("id",""), sym.get("name",""), sym.get("category","custom"),
         sym.get("dataURL",""),
         sym.get("widthMm")    or None,
         sym.get("heightMm")   or None,
         sym.get("shapesJson") or None]
    )
    con.commit()

def db_delete_symbol(sym_id):
    con = _sym_con()
    con.execute("DELETE FROM symbols WHERE id=?", [sym_id])
    con.commit()


# --------------------------------------------------------------------------- #
#  HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "DevineEstimator/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ----------------------------------------------------------- #
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, msg, status=400):
        self._send_json({"error": str(msg)}, status)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def log_message(self, fmt, *args):  # quieter logging
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    # -- static files ------------------------------------------------------ #
    def _serve_static(self, rel):
        rel = urllib.parse.unquote(rel)
        if rel in ("", "/"):
            rel = "index.html"
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404, "Not found")
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404, "Not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- routing ----------------------------------------------------------- #
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/session":
                return self._send_json(load_session())
            if path == "/api/settings":
                cfg = load_config()
                cfg["dbExists"] = os.path.exists(cfg["dbPath"])
                return self._send_json(cfg)
            if path == "/api/parts":
                search = (qs.get("q", [""])[0]).strip()
                limit = int(qs.get("limit", ["100"])[0])
                return self._send_json({"parts": query_parts(load_config(), search, limit)})
            if path == "/api/packages":
                return self._send_json({"packages": db_load_packages()})
            if path == "/api/symbols":
                return self._send_json({"symbols": db_load_symbols()})
            if path == "/api/projects":
                return self._send_json({"projects": list_projects()})
            if path.startswith("/api/projects/"):
                name = path[len("/api/projects/"):]
                p = project_path(urllib.parse.unquote(name))
                if not os.path.exists(p):
                    return self._send_error_json("Project not found", 404)
                with open(p, "r", encoding="utf-8") as fh:
                    return self._send_json(json.load(fh))
            if path == "/api/backup/database":
                return self._backup_database()
            if path == "/api/backup/projects":
                return self._backup_projects()
            if path.startswith("/api/") :
                return self._send_error_json("Unknown endpoint", 404)
            # static
            return self._serve_static(path if path != "/" else "index.html")
        except FileNotFoundError as exc:
            return self._send_error_json(exc, 400)
        except Exception as exc:  # noqa: BLE001
            return self._send_error_json(exc, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/settings":
                body = self._read_body()
                cfg = load_config()
                if "dbPath" in body:
                    cfg["dbPath"] = str(body["dbPath"]).strip()
                if "table" in body and str(body["table"]).strip():
                    cfg["table"] = str(body["table"]).strip()
                if isinstance(body.get("columns"), dict):
                    # Note: empty string is allowed -> clears an OPTIONAL column mapping
                    # (e.g. category/unit). Required columns are validated below.
                    cfg["columns"].update(
                        {k: ("" if v is None else str(v).strip())
                         for k, v in body["columns"].items()}
                    )
                save_config(cfg)
                result = {"ok": True, "dbExists": os.path.exists(cfg["dbPath"])}
                # validate by attempting a tiny query
                if result["dbExists"]:
                    try:
                        query_parts(cfg, "", 1)
                        result["valid"] = True
                    except Exception as exc:  # noqa: BLE001
                        result["valid"] = False
                        result["warning"] = str(exc)
                return self._send_json(result)
            if path == "/api/projects":
                body = self._read_body()
                name = body.get("name")
                if not name:
                    return self._send_error_json("Project name required")
                data = body.get("data", {})
                p = project_path(name)
                payload = {"name": safe_project_name(name), "savedAt": time.time(), "data": data}
                tmp = p + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh)
                os.replace(tmp, p)
                save_session({"lastProject": payload["name"]})
                return self._send_json({"ok": True, "name": payload["name"]})
            if path == "/api/import-dxf":
                return self._handle_dxf_import()
            if path == "/api/import-parts":
                return self._handle_parts_import()
            if path == "/api/parts":
                # Create a new part
                body = self._read_body()
                cfg = load_config()
                if cfg["dbPath"].lower().endswith(".csv"):
                    return self._send_error_json("Read-only CSV source")
                con, table = get_connection(cfg)
                cols = cfg["columns"]
                col_part   = cols.get("part_no",     "part_no")
                col_desc   = cols.get("description", "description")
                col_cost   = cols.get("cost",        "cost")
                col_retail = cols.get("retail",      "retail")
                col_cat    = cols.get("category",    "category")
                col_unit   = cols.get("unit",        "unit")
                pn = str(body.get("part_no", "")).strip()
                if not pn:
                    return self._send_error_json("part_no required")
                con.execute(
                    'INSERT OR REPLACE INTO "%s" ("%s","%s","%s","%s","%s","%s") VALUES (?,?,?,?,?,?)' % (
                        table, col_part, col_desc, col_cost, col_retail, col_cat, col_unit),
                    [pn, body.get("description",""), float(body.get("cost",0) or 0),
                     float(body.get("retail",0) or 0), body.get("category",""), body.get("unit","")])
                con.commit()
                return self._send_json({"ok": True})
            if path == "/api/packages":
                body = self._read_body()
                if not str(body.get("part_no", "")).strip():
                    return self._send_error_json("part_no required")
                db_upsert_package(body)
                return self._send_json({"ok": True})
            if path == "/api/symbols":
                body = self._read_body()
                if not str(body.get("id", "")).strip():
                    return self._send_error_json("id required")
                db_upsert_symbol(body)
                return self._send_json({"ok": True})
            if path == "/api/restore/database":
                return self._restore_database()
            if path == "/api/restore/projects":
                return self._restore_projects()
            return self._send_error_json("Unknown endpoint", 404)
        except Exception as exc:  # noqa: BLE001
            return self._send_error_json(exc, 500)

    def _handle_parts_import(self):
        """Import parts from a CSV upload.
        Expects SM8-style columns: Item Number, Name, Purchase Cost, Price
        Upserts into the parts SQLite table: adds new rows, updates cost/retail on existing.
        Returns JSON: {added, updated, skipped, total}
        """
        ct = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return self._send_error_json("Empty body")
        raw = self.rfile.read(length)
        import re as _re
        bm = _re.search(r"boundary=([^\s;]+)", ct)
        if not bm:
            return self._send_error_json("No boundary in Content-Type")
        boundary = ("--" + bm.group(1)).encode()
        parts_mp = raw.split(boundary)
        file_data = None
        for part in parts_mp:
            if b"filename=" not in part:
                continue
            sep = part.find(b"\r\n\r\n")
            if sep != -1:
                file_data = part[sep + 4:].rstrip(b"\r\n--")
        if not file_data:
            return self._send_error_json("No file found in upload")
        try:
            text = file_data.decode("utf-8-sig", errors="replace")
        except Exception as exc:
            return self._send_error_json("Could not decode file: " + str(exc))

        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        if not rows:
            return self._send_error_json("CSV file is empty")

        raw_header = [h.strip() for h in rows[0]]
        header_lower = [h.lower() for h in raw_header]

        def find_col(*names):
            for n in names:
                try: return header_lower.index(n.lower())
                except ValueError: pass
            return None

        idx_part   = find_col("item number", "part_no", "part no", "partno", "sku", "code")
        idx_name   = find_col("name", "description", "desc")
        idx_cost   = find_col("purchase cost", "cost", "buy price", "cost price")
        idx_retail = find_col("price", "retail", "sell price", "retail price")

        if idx_part is None or idx_name is None:
            return self._send_error_json(
                "Could not find required columns. Found: " + ", ".join(raw_header[:12]))

        cfg = load_config()
        if cfg["dbPath"].lower().endswith(".csv"):
            return self._send_error_json("Parts DB is a CSV file — switch to a SQLite .db file in Settings to enable import.")
        try:
            con, table = get_connection(cfg)
        except Exception as exc:
            return self._send_error_json("Cannot open parts DB: " + str(exc))

        col_part   = cfg["columns"].get("part_no", "part_no")
        col_desc   = cfg["columns"].get("description", "description")
        col_cost   = cfg["columns"].get("cost", "cost")
        col_retail = cfg["columns"].get("retail", "retail")

        existing = set(r[0] for r in con.execute('SELECT "%s" FROM "%s"' % (col_part, table)).fetchall())

        def safe_float(val):
            try: return float(str(val).replace(",", "").strip())
            except: return None

        added = updated = skipped = 0
        data_rows = rows[1:]
        total = len(data_rows)
        progress = []

        for i, row in enumerate(data_rows):
            if not row: skipped += 1; continue
            part_no = row[idx_part].strip() if idx_part < len(row) else ""
            name    = row[idx_name].strip()  if idx_name  < len(row) else ""
            if not part_no or not name: skipped += 1; continue
            cost   = safe_float(row[idx_cost])   if (idx_cost   is not None and idx_cost   < len(row)) else None
            retail = safe_float(row[idx_retail]) if (idx_retail is not None and idx_retail < len(row)) else None

            if part_no in existing:
                sets, vals = [], []
                if cost   is not None: sets.append('"%s"=?' % col_cost);   vals.append(cost)
                if retail is not None: sets.append('"%s"=?' % col_retail); vals.append(retail)
                if sets:
                    vals.append(part_no)
                    con.execute('UPDATE "%s" SET %s WHERE "%s"=?' % (table, ",".join(sets), col_part), vals)
                updated += 1
            else:
                con.execute(
                    'INSERT INTO "%s" ("%s","%s","%s","%s") VALUES (?,?,?,?)' % (
                        table, col_part, col_desc, col_cost, col_retail),
                    [part_no, name, cost if cost is not None else 0.0, retail if retail is not None else 0.0])
                existing.add(part_no)
                added += 1

            if (i + 1) % 500 == 0:
                con.commit()
                progress.append({"processed": i + 1, "total": total, "added": added, "updated": updated, "skipped": skipped})

        con.commit()
        return self._send_json({
            "ok": True, "added": added, "updated": updated, "skipped": skipped, "total": total,
            "progress": progress
        })

    def _handle_dxf_import(self):
        """Parse a DXF file using only the Python stdlib.

        Strategy
        --------
        The DXF is a text file of (group-code, value) pairs.  We parse every
        entity into a dict of group codes, then:

        1.  Collect all TEXT entities to extract symbol names/descriptions.
            The file has two columns:
              Left  (X ~11500-11700): symbol descriptions (GPO, switch, etc.)
              Right (X ~13800-14000): other symbols (TV aerial, thermostat...)
            Multi-line descriptions that share the same Y-band are joined.

        2.  For every label Y-position, collect nearby geometry (LINE, ARC,
            CIRCLE, LWPOLYLINE) and render it as a normalised SVG icon.

        3.  Return { symbols: [{name, description, dataURL}, ...] }
        """
        import base64 as _b64
        import math as _math

        ct = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            return self._send_error_json("Expected multipart/form-data")
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return self._send_error_json("Empty body")
        raw = self.rfile.read(length)
        bm = re.search(r"boundary=([^\s;]+)", ct)
        if not bm:
            return self._send_error_json("No boundary in Content-Type")
        boundary = ("--" + bm.group(1)).encode()
        parts_mp = raw.split(boundary)
        file_data = None
        for part in parts_mp:
            if b"filename=" not in part:
                continue
            sep = part.find(b"\r\n\r\n")
            if sep != -1:
                file_data = part[sep + 4:].rstrip(b"\r\n--")
        if not file_data:
            return self._send_error_json("No file found in upload")

        # decode text
        for enc in ("utf-8", "cp1251", "latin-1"):
            try:
                text = file_data.decode(enc)
                break
            except Exception:
                pass
        else:
            return self._send_error_json("Could not decode DXF file")

        # parse DXF entities
        def parse_entities(text):
            lines = [l.rstrip("\r\n") for l in text.splitlines()]
            entities = []
            i = 0
            while i < len(lines) - 1:
                if lines[i].strip() == "0":
                    etype = lines[i + 1].strip()
                    if etype in ("LINE", "ARC", "CIRCLE", "LWPOLYLINE", "TEXT", "MTEXT"):
                        raw_pairs = []
                        j = i + 2
                        while j < len(lines) - 1:
                            if lines[j].strip() == "0":
                                break
                            raw_pairs.append((lines[j].strip(), lines[j + 1].strip()))
                            j += 2
                        entities.append({"type": etype, "pairs": raw_pairs})
                        i = j
                        continue
                i += 2
            return entities

        def first(pairs, code):
            for c, v in pairs:
                if c == code:
                    return v
            return None

        def all_vals(pairs, code):
            return [v for c, v in pairs if c == code]

        def flt(v, default=0.0):
            try:
                return float(v)
            except Exception:
                return default

        entities = parse_entities(text)

        # collect TEXT labels
        raw_labels = []
        for e in entities:
            if e["type"] not in ("TEXT", "MTEXT"):
                continue
            txt = (first(e["pairs"], "1") or "").strip()
            if not txt:
                continue
            # skip pure numbers (the "2"/"3" annotations next to switches)
            if txt.lstrip("-").replace(".", "").isdigit():
                continue
            # skip single-letter badges (SA, CU, H, S, A)
            if len(txt) <= 2:
                continue
            x = flt(first(e["pairs"], "10"))
            y = flt(first(e["pairs"], "20"))
            raw_labels.append((y, x, txt))

        raw_labels.sort(key=lambda t: (-t[0], t[1]))

        # cluster labels that share a Y band into one symbol.
        # The file has two columns separated at X ~12500:
        #   Left  (X 11400-12500): socket / switch / lighting symbols
        #   Right (X 12500+):      other symbols (aerial, thermostat, alarm…)
        # Continuation lines (e.g. "1200MM ABOVE FLOOR LEVEL" after the
        # primary name) are within ~110 DXF units vertically; inter-symbol
        # gaps are always > 130 units.
        LABEL_X_MIN = 11400
        COL_SPLIT   = 12500
        Y_BAND      = 110    # continuation-line threshold (< inter-symbol gap)

        desc_labels = [(y, x, t) for y, x, t in raw_labels if x > LABEL_X_MIN]
        left_labels  = [(y, x, t) for y, x, t in desc_labels if x <= COL_SPLIT]
        right_labels = [(y, x, t) for y, x, t in desc_labels if x >  COL_SPLIT]

        def cluster_labels(labels):
            groups = []
            for y, x, t in labels:
                merged = False
                for g in groups:
                    if abs(g["y"] - y) < Y_BAND:
                        if t not in g["lines"]:
                            g["lines"].append(t)
                        merged = True
                        break
                if not merged:
                    groups.append({"y": y, "x": x, "lines": [t]})
            return groups

        symbol_groups = cluster_labels(left_labels) + cluster_labels(right_labels)

        symbol_defs = []
        for g in symbol_groups:
            lines_list = g["lines"]
            name = lines_list[0].title()
            description = " - ".join(l.title() for l in lines_list[1:]) if len(lines_list) > 1 else ""
            symbol_defs.append({
                "y": g["y"],
                "x": g["x"],
                "name": name,
                "description": description,
            })

        if not symbol_defs:
            return self._send_json({"symbols": [], "error": "No text labels found in DXF."})

        # collect geometry near each symbol
        geom_entities = [e for e in entities if e["type"] in ("LINE", "ARC", "CIRCLE", "LWPOLYLINE", "TEXT", "MTEXT")]

        def entity_center(e):
            px = flt(first(e["pairs"], "10"))
            py = flt(first(e["pairs"], "20"))
            return px, py

        def entity_detail(e):
            p = e["pairs"]
            t = e["type"]
            if t == "LINE":
                return {
                    "t": "L",
                    "x1": flt(first(p, "10")), "y1": flt(first(p, "20")),
                    "x2": flt(first(p, "11")), "y2": flt(first(p, "21")),
                }
            if t == "CIRCLE":
                return {
                    "t": "C",
                    "cx": flt(first(p, "10")), "cy": flt(first(p, "20")),
                    "r":  flt(first(p, "40")),
                }
            if t == "ARC":
                return {
                    "t": "A",
                    "cx": flt(first(p, "10")), "cy": flt(first(p, "20")),
                    "r":  flt(first(p, "40")),
                    "sa": flt(first(p, "50")), "ea": flt(first(p, "51")),
                }
            if t == "LWPOLYLINE":
                xs = all_vals(p, "10")
                ys = all_vals(p, "20")
                return {
                    "t": "P",
                    "pts": list(zip([flt(v) for v in xs], [flt(v) for v in ys])),
                }
            if t in ("TEXT", "MTEXT"):
                label = (first(p, "1") or "").strip()
                # Only collect short badge markers (digits or 2-char codes like SA, CU)
                if label and len(label) <= 2:
                    return {
                        "t": "TX",
                        "x": flt(first(p, "10")), "y": flt(first(p, "20")),
                        "s": label,
                    }
                return None
            return None

        def geom_for_symbol(sym_y, sym_x, y_tol=130):
            if sym_x < 12500:
                x_lo, x_hi = 11200, 11600
            else:
                x_lo, x_hi = 13540, 13810
            result = []
            for e in geom_entities:
                ex, ey = entity_center(e)
                if x_lo <= ex <= x_hi and abs(ey - sym_y) < y_tol:
                    d = entity_detail(e)
                    if d:
                        result.append(d)
            return result

        SVG_SIZE = 80
        PADDING  = 6

        def normalise(geom):
            pts = []
            for g in geom:
                t = g["t"]
                if t == "TX":
                    continue  # badge labels — don't affect bounding box
                if t == "L":
                    dx = g["x2"] - g["x1"]; dy = g["y2"] - g["y1"]
                    if (dx*dx + dy*dy) < 4: continue  # skip noise
                    pts += [(g["x1"], g["y1"]), (g["x2"], g["y2"])]
                elif t in ("C", "A"):
                    r = g["r"]
                    pts += [(g["cx"] - r, g["cy"] - r), (g["cx"] + r, g["cy"] + r)]
                elif t == "P":
                    pts += g["pts"]
            if not pts:
                return None, None, None, None
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            w = max_x - min_x or 1
            h = max_y - min_y or 1
            draw_area = SVG_SIZE - PADDING * 2
            scale = draw_area / max(w, h)
            cx = (min_x + max_x) / 2
            cy = (min_y + max_y) / 2
            offset_x = SVG_SIZE / 2 - cx * scale
            offset_y = SVG_SIZE / 2 + cy * scale  # DXF Y is inverted vs SVG
            return scale, offset_x, offset_y, (min_x, min_y, max_x, max_y)

        def tx(x, scale, offset_x):
            return round(x * scale + offset_x, 2)

        def ty(y, scale, offset_y):
            return round(-y * scale + offset_y, 2)

        def arc_svg(cx, cy, r, sa_deg, ea_deg, scale, ox, oy):
            sa = _math.radians(sa_deg)
            ea = _math.radians(ea_deg)
            while ea < sa:
                ea += 2 * _math.pi
            sx_pt = tx(cx + r * _math.cos(sa), scale, ox)
            sy_pt = ty(cy + r * _math.sin(sa), scale, oy)
            ex_pt = tx(cx + r * _math.cos(ea), scale, ox)
            ey_pt = ty(cy + r * _math.sin(ea), scale, oy)
            sr    = round(r * scale, 2)
            span  = ea - sa
            large = 1 if span > _math.pi else 0
            # Y-axis is flipped (ty inverts), so arc direction reverses:
            # DXF CCW becomes SVG CW → invert sweep flag
            sweep = 0 if span <= _math.pi else 1
            return f"M {sx_pt} {sy_pt} A {sr} {sr} 0 {large} {sweep} {ex_pt} {ey_pt}"

        def geom_to_svg_paths(geom, scale, ox, oy):
            paths = []
            stroke = "#38bdf8"
            sw = round(SVG_SIZE * 0.028, 1)  # ~2.2px at 80, scales with canvas
            for g in geom:
                t = g["t"]
                if t == "L":
                    # Skip near-zero-length lines (DXF noise / arc-join artefacts)
                    dx = g["x2"] - g["x1"]; dy = g["y2"] - g["y1"]
                    if (dx*dx + dy*dy) < 4:   # shorter than 2 DXF units
                        continue
                    x1 = tx(g["x1"], scale, ox); y1 = ty(g["y1"], scale, oy)
                    x2 = tx(g["x2"], scale, ox); y2 = ty(g["y2"], scale, oy)
                    paths.append(
                        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
                        f'stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round"/>'
                    )
                elif t == "C":
                    ccx = tx(g["cx"], scale, ox); ccy = ty(g["cy"], scale, oy)
                    cr  = round(g["r"] * scale, 2)
                    paths.append(
                        f'<circle cx="{ccx}" cy="{ccy}" r="{cr}" '
                        f'fill="none" stroke="{stroke}" stroke-width="{sw}"/>'
                    )
                elif t == "A":
                    d = arc_svg(g["cx"], g["cy"], g["r"], g["sa"], g["ea"], scale, ox, oy)
                    paths.append(
                        f'<path d="{d}" fill="none" stroke="{stroke}" '
                        f'stroke-width="{sw}" stroke-linecap="round"/>'
                    )
                elif t == "P" and len(g["pts"]) >= 2:
                    pts_str = " ".join(
                        f'{tx(px, scale, ox)},{ty(py, scale, oy)}'
                        for px, py in g["pts"]
                    )
                    paths.append(
                        f'<polyline points="{pts_str}" fill="none" '
                        f'stroke="{stroke}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
                    )
                elif t == "TX":
                    # Badge label — render at its actual position in SVG coords
                    bx = tx(g["x"], scale, ox)
                    by = ty(g["y"], scale, oy)
                    fs = round(SVG_SIZE * 0.18)
                    paths.append(
                        f'<text x="{bx}" y="{by}" '
                        f'fill="#ffb02e" font-family="sans-serif" font-size="{fs}" '
                        f'font-weight="700" dominant-baseline="central">{g["s"]}</text>'
                    )
            return "\n".join(paths)

        def make_badge_svg(name):
            label = "".join(w[0] for w in name.split() if w)[:3].upper() or "?"
            return (
                f"<svg xmlns='http://www.w3.org/2000/svg' width='{SVG_SIZE}' height='{SVG_SIZE}' "
                f"viewBox='0 0 {SVG_SIZE} {SVG_SIZE}'>"
                f"<rect x='2' y='2' width='40' height='40' rx='8' fill='#10151d' "
                f"stroke='#38bdf8' stroke-width='2'/>"
                f"<text x='22' y='22' fill='#f0f4f8' font-family='sans-serif' font-size='12' "
                f"font-weight='700' text-anchor='middle' dominant-baseline='central'>{label}</text>"
                f"</svg>"
            )

        def make_symbol_svg(name, geom):
            scale, ox, oy, bbox = normalise(geom)
            if scale is None:
                return make_badge_svg(name)
            paths_svg = geom_to_svg_paths(geom, scale, ox, oy)
            if not paths_svg.strip():
                return make_badge_svg(name)
            return (
                f"<svg xmlns='http://www.w3.org/2000/svg' width='{SVG_SIZE}' height='{SVG_SIZE}' "
                f"viewBox='0 0 {SVG_SIZE} {SVG_SIZE}'>"
                f"<rect x='0' y='0' width='{SVG_SIZE}' height='{SVG_SIZE}' rx='6' "
                f"fill='#0e1219' opacity='0.85'/>"
                f"{paths_svg}"
                f"</svg>"
            )

        def dedupe_geom(geom):
            seen = set(); out = []
            for g in geom:
                key = str(sorted(g.items()))
                if key not in seen:
                    seen.add(key); out.append(g)
            return out

        try:
            symbols = []
            for sym in symbol_defs:
                geom = dedupe_geom(geom_for_symbol(sym["y"], sym["x"]))
                svg  = make_symbol_svg(sym["name"], geom)
                data_url = "data:image/svg+xml;base64," + _b64.b64encode(svg.encode()).decode()
                symbols.append({
                    "name":        sym["name"],
                    "description": sym["description"],
                    "dataURL":     data_url,
                })
            if not symbols:
                return self._send_json({"symbols": [], "error": "No symbols could be extracted."})
            return self._send_json({"symbols": symbols})
        except Exception as exc:
            return self._send_error_json("DXF parse error: " + str(exc))

    # -- backup / restore -------------------------------------------------- #
    def _send_file(self, data, filename, mime="application/octet-stream"):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _backup_database(self):
        cfg = load_config()
        db_path = cfg["dbPath"]
        if not os.path.exists(db_path):
            return self._send_error_json("Database file not found")
        # Use SQLite backup API so we get a consistent snapshot even if DB is open
        buf = io.BytesIO()
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(":memory:")
        src.backup(dst)
        src.close()
        tmp = io.BytesIO()
        # Write the in-memory DB to bytes via a temp file path trick
        import tempfile, pathlib
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tf:
            tf_path = tf.name
        try:
            src2 = sqlite3.connect(db_path)
            dst2 = sqlite3.connect(tf_path)
            src2.backup(dst2); src2.close(); dst2.close()
            with open(tf_path, "rb") as f:
                data = f.read()
        finally:
            try: os.unlink(tf_path)
            except OSError: pass
        ts = time.strftime("%Y%m%d_%H%M%S")
        self._send_file(data, "parts_backup_%s.db" % ts)

    def _backup_projects(self):
        buf = io.BytesIO()
        ts = time.strftime("%Y%m%d_%H%M%S")
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            # All project JSON files
            if os.path.isdir(PROJECTS_DIR):
                for fn in sorted(os.listdir(PROJECTS_DIR)):
                    if fn.endswith(".json"):
                        zf.write(os.path.join(PROJECTS_DIR, fn), "projects/" + fn)
            # Symbol library export
            try:
                syms = db_load_symbols()
                zf.writestr("symbols.json", json.dumps(syms, ensure_ascii=False, indent=2))
            except Exception:
                pass
        data = buf.getvalue()
        self._send_file(data, "project_backup_%s.zip" % ts, "application/zip")

    def _read_upload_bytes(self):
        """Parse multipart/form-data and return the raw file bytes."""
        ct = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        if "multipart/form-data" in ct:
            bm = re.search(r"boundary=([^\s;]+)", ct)
            if not bm:
                return None
            boundary = ("--" + bm.group(1)).encode()
            for part in raw.split(boundary):
                if b"filename=" not in part:
                    continue
                sep = part.find(b"\r\n\r\n")
                if sep != -1:
                    return part[sep + 4:].rstrip(b"\r\n--")
            return None
        return raw  # raw binary body

    def _restore_database(self):
        data = self._read_upload_bytes()
        if not data:
            return self._send_error_json("No file received")
        # Validate it looks like a SQLite file
        if not data.startswith(b"SQLite format 3"):
            return self._send_error_json("File does not appear to be a valid SQLite database")
        cfg = load_config()
        db_path = cfg["dbPath"]
        # Close any cached connection to this path
        with _sqlite_lock:
            if db_path in _sqlite_cache:
                try: _sqlite_cache[db_path].close()
                except Exception: pass
                del _sqlite_cache[db_path]
        # Write backup of current DB first
        if os.path.exists(db_path):
            shutil.copy2(db_path, db_path + ".bak")
        with open(db_path, "wb") as f:
            f.write(data)
        return self._send_json({"ok": True, "message": "Database restored successfully"})

    def _restore_projects(self):
        data = self._read_upload_bytes()
        if not data:
            return self._send_error_json("No file received")
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile:
            return self._send_error_json("File does not appear to be a valid zip archive")
        restored_projects = 0
        restored_symbols  = 0
        for name in zf.namelist():
            if name.startswith("projects/") and name.endswith(".json"):
                fn = os.path.basename(name)
                if fn:
                    dest = os.path.join(PROJECTS_DIR, fn)
                    with open(dest, "wb") as f:
                        f.write(zf.read(name))
                    restored_projects += 1
            elif name == "symbols.json":
                try:
                    syms = json.loads(zf.read(name).decode("utf-8"))
                    for sym in syms:
                        if sym.get("id"):
                            db_upsert_symbol(sym)
                    restored_symbols = len(syms)
                except Exception:
                    pass
        zf.close()
        return self._send_json({"ok": True,
            "projects": restored_projects, "symbols": restored_symbols})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/projects/"):
            name = urllib.parse.unquote(path[len("/api/projects/"):])
            p = project_path(name)
            if os.path.exists(p):
                os.remove(p)
                # Clear session if this was the last-open project
                sess = load_session()
                if sess.get("lastProject") == safe_project_name(name):
                    save_session({})
                return self._send_json({"ok": True})
            return self._send_error_json("Project not found", 404)
        if path.startswith("/api/parts/"):
            part_no = urllib.parse.unquote(path[len("/api/parts/"):])
            cfg = load_config()
            if cfg["dbPath"].lower().endswith(".csv"):
                return self._send_error_json("Read-only CSV source")
            con, table = get_connection(cfg)
            col_part = cfg["columns"].get("part_no", "part_no")
            con.execute('DELETE FROM "%s" WHERE "%s"=?' % (table, col_part), [part_no])
            con.commit()
            return self._send_json({"ok": True})
        if path.startswith("/api/packages/"):
            part_no = urllib.parse.unquote(path[len("/api/packages/"):])
            db_delete_package(part_no)
            return self._send_json({"ok": True})
        if path.startswith("/api/symbols/"):
            sym_id = urllib.parse.unquote(path[len("/api/symbols/"):])
            db_delete_symbol(sym_id)
            return self._send_json({"ok": True})
        return self._send_error_json("Unknown endpoint", 404)

    def do_PUT(self):
        """Update an existing part: PUT /api/parts/<part_no>"""
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/parts/"):
                part_no = urllib.parse.unquote(path[len("/api/parts/"):])
                body = self._read_body()
                cfg = load_config()
                if cfg["dbPath"].lower().endswith(".csv"):
                    return self._send_error_json("Read-only CSV source")
                con, table = get_connection(cfg)
                cols = cfg["columns"]
                col_part   = cols.get("part_no", "part_no")
                col_desc   = cols.get("description", "description")
                col_cost   = cols.get("cost", "cost")
                col_retail = cols.get("retail", "retail")
                col_cat    = cols.get("category", "category")
                col_unit   = cols.get("unit", "unit")
                sets, vals = [], []
                field_map = {
                    "description": col_desc, "cost": col_cost,
                    "retail": col_retail, "category": col_cat, "unit": col_unit
                }
                for key, col in field_map.items():
                    if key in body and col:
                        sets.append('"%s"=?' % col)
                        vals.append(body[key])
                if not sets:
                    return self._send_error_json("No fields to update")
                vals.append(part_no)
                con.execute('UPDATE "%s" SET %s WHERE "%s"=?' % (table, ",".join(sets), col_part), vals)
                con.commit()
                return self._send_json({"ok": True})
            return self._send_error_json("Unknown endpoint", 404)
        except Exception as exc:  # noqa: BLE001
            return self._send_error_json(exc, 500)


def main():
    ap = argparse.ArgumentParser(description="The Devine Estimator backend")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=80)
    args = ap.parse_args()

    if not os.path.exists(CONFIG_PATH):
        save_config(DEFAULT_CONFIG)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print("The Devine Estimator running at http://%s%s/" % (args.host, (":" + str(args.port)) if args.port != 80 else ""))
    print("Parts DB: %s" % load_config()["dbPath"])
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
