import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

TABLES_DDL = """
CREATE TABLE {name} (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER NOT NULL REFERENCES dt_domains(id),
    name TEXT NOT NULL,
    label TEXT,
    description TEXT,
    parent_id INTEGER REFERENCES dt_tables(id),
    relation TEXT NOT NULL DEFAULT 'one_to_many',
    on_delete TEXT NOT NULL DEFAULT 'cascade',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (domain_id, name)
);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS dt_domains (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    label TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dt_fields (
    id INTEGER PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES dt_tables(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT,
    description TEXT,
    type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    uniq INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    options TEXT,
    config TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (table_id, key)
);
CREATE TABLE IF NOT EXISTS dt_records (
    id INTEGER PRIMARY KEY,
    table_id INTEGER NOT NULL REFERENCES dt_tables(id),
    parent_id INTEGER REFERENCES dt_records(id),
    data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_records_table ON dt_records (table_id, id);
CREATE INDEX IF NOT EXISTS ix_records_parent ON dt_records (parent_id);
CREATE TABLE IF NOT EXISTS dt_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tx TEXT NOT NULL,
    domain TEXT,
    table_name TEXT NOT NULL,
    record_id INTEGER,
    op TEXT NOT NULL,
    before TEXT,
    after TEXT,
    fields TEXT,
    actor TEXT,
    ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dt_change_fields (
    seq INTEGER NOT NULL,
    field TEXT NOT NULL,
    PRIMARY KEY (seq, field)
);
CREATE TABLE IF NOT EXISTS dt_counters (
    table_id INTEGER NOT NULL,
    field_key TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (table_id, field_key)
);
CREATE TABLE IF NOT EXISTS dt_bindings (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL,
    name TEXT NOT NULL,
    ops TEXT NOT NULL,
    table_name TEXT,
    field TEXT,
    where_expr TEXT,
    where_before TEXT,
    prompt TEXT,
    action TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (domain, name)
);
CREATE TABLE IF NOT EXISTS dt_deliveries (
    id INTEGER PRIMARY KEY,
    binding_id INTEGER NOT NULL REFERENCES dt_bindings(id) ON DELETE CASCADE,
    change_seq INTEGER NOT NULL,
    last_seq INTEGER,
    seqs TEXT,
    event_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (binding_id, change_seq)
);
CREATE TABLE IF NOT EXISTS dt_inbox (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL,
    binding_id INTEGER REFERENCES dt_bindings(id) ON DELETE SET NULL,
    binding_name TEXT,
    event_seq INTEGER,
    table_name TEXT,
    record_id INTEGER,
    op TEXT,
    title TEXT NOT NULL,
    body TEXT,
    prompt TEXT,
    events TEXT,
    status TEXT NOT NULL DEFAULT 'unread',
    created_at TEXT NOT NULL,
    read_at TEXT,
    UNIQUE (binding_id, event_seq)
);
"""

# 依赖新列的索引放在迁移之后建
INDEXES = """
CREATE INDEX IF NOT EXISTS ix_tables_domain ON dt_tables (domain_id);
CREATE INDEX IF NOT EXISTS ix_changes_record ON dt_changes (domain, table_name, record_id);
CREATE INDEX IF NOT EXISTS ix_change_fields_field ON dt_change_fields (field, seq);
CREATE INDEX IF NOT EXISTS ix_deliveries_due ON dt_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_inbox_domain ON dt_inbox (domain, status, id);
"""

LEGACY_DOMAIN = "default"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dumps(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def dt_home() -> Path:
    return Path(os.environ.get("DT_HOME") or Path.home() / ".dt").expanduser()


class Tx:
    """一次写事务：共享时间戳、操作者和 tx id，并把每个修改记进 dt_changes。"""

    def __init__(self, conn: sqlite3.Connection, actor: str, *, suppress_bindings: bool = False):
        self.conn = conn
        self.actor = actor
        self.id = uuid.uuid4().hex[:12]
        self.ts = now()
        # 当前操作的域；由调用方在事务开始后设置
        self.domain: str | None = None
        self.domain_id: int | None = None
        # 绑定动作自己写库时置 True，避免触发新的订阅（防事件回环）
        self.suppress_bindings = suppress_bindings
        # 一次写事务里缓存绑定，并把命中事件先在内存里按绑定合并，提交前写成投递
        self.binding_cache = None
        self.delivery_seqs: dict[int, list[int]] = {}

    def execute(self, sql: str, params=()):
        return self.conn.execute(sql, params)

    def flush(self):
        """提交前把内存里合并的事件写成投递。"""
        from dt import events

        events.flush_deliveries(self)

    def log(self, table_name: str, record_id, op: str, before=None, after=None):
        from dt import events  # 避免 db ← records ← events 的循环导入

        fields = events.diff_fields(before, after) if op in ("insert", "update", "delete") else None
        cur = self.conn.execute(
            "INSERT INTO dt_changes (tx, domain, table_name, record_id, op, before, after, fields, actor, ts)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                self.id, self.domain, table_name, record_id, op,
                None if before is None else dumps(before),
                None if after is None else dumps(after),
                None if fields is None else dumps(fields),
                self.actor, self.ts,
            ),
        )
        seq = cur.lastrowid
        if fields:
            self.conn.executemany(
                "INSERT OR IGNORE INTO dt_change_fields (seq, field) VALUES (?, ?)",
                [(seq, key) for key in fields],
            )
        if fields is not None and self.domain is not None and not self.suppress_bindings:
            events.emit(self, seq, table_name, record_id, op, before, after, fields)


class Database:
    def __init__(self, path: str | Path):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.executescript(SCHEMA)
        self._migrate(path)
        self.conn.executescript(INDEXES)
        self._migrate_events()
        self.lock = threading.RLock()
        self.listeners: list = []  # 每次提交写事务后调用，用于实时推送

    def _migrate_events(self):
        """旧库补上事件字段和字段索引，并回填已有的记录变更。"""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_changes)")}
        if "fields" not in cols:
            self.conn.execute("ALTER TABLE dt_changes ADD COLUMN fields TEXT")
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_deliveries)")}
        if "last_seq" not in cols:
            self.conn.execute("ALTER TABLE dt_deliveries ADD COLUMN last_seq INTEGER")
        if "seqs" not in cols:
            self.conn.execute("ALTER TABLE dt_deliveries ADD COLUMN seqs TEXT")
        if "event_count" not in cols:
            self.conn.execute("ALTER TABLE dt_deliveries ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1")
        if "last_result" not in cols:
            self.conn.execute("ALTER TABLE dt_deliveries ADD COLUMN last_result TEXT")
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_bindings)")}
        if "prompt" not in cols:
            self.conn.execute("ALTER TABLE dt_bindings ADD COLUMN prompt TEXT")
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_inbox)")}
        if "prompt" not in cols:
            self.conn.execute("ALTER TABLE dt_inbox ADD COLUMN prompt TEXT")

        rows = self.conn.execute(
            "SELECT seq, before, after FROM dt_changes"
            " WHERE op IN ('insert', 'update', 'delete') AND fields IS NULL"
        ).fetchall()
        if not rows:
            return
        from dt import events

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            for row in rows:
                before = json.loads(row["before"]) if row["before"] else None
                after = json.loads(row["after"]) if row["after"] else None
                fields = events.diff_fields(before, after)
                self.conn.execute("UPDATE dt_changes SET fields = ? WHERE seq = ?", (dumps(fields), row["seq"]))
                self.conn.executemany(
                    "INSERT OR IGNORE INTO dt_change_fields (seq, field) VALUES (?, ?)",
                    [(row["seq"], key) for key in fields],
                )
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise

    def _migrate(self, path):
        """新库直接建 dt_tables；没有「域」的旧库先备份，再把已有的表都放进 default 域。"""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_tables)")}
        if not cols:
            self.conn.execute(TABLES_DDL.format(name="dt_tables"))
            return
        if "domain_id" in cols:
            return
        if str(path) != ":memory:":
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            backup = Path(f"{path}.bak-{datetime.now().strftime('%Y%m%d%H%M%S')}")
            dest = sqlite3.connect(backup)
            self.conn.backup(dest)
            dest.close()
        ts = now()
        self.conn.execute("PRAGMA foreign_keys=OFF")
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            domain_id = self.conn.execute(
                "INSERT INTO dt_domains (name, label, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (LEGACY_DOMAIN, "默认", ts, ts),
            ).lastrowid
            self.conn.execute(TABLES_DDL.format(name="dt_tables_new"))
            self.conn.execute(
                "INSERT INTO dt_tables_new (id, domain_id, name, label, description, parent_id, relation, on_delete,"
                " schema_version, created_at, updated_at) SELECT id, ?, name, label, description, parent_id, relation,"
                " on_delete, schema_version, created_at, updated_at FROM dt_tables",
                (domain_id,),
            )
            self.conn.execute("DROP TABLE dt_tables")
            self.conn.execute("ALTER TABLE dt_tables_new RENAME TO dt_tables")
            if "domain" not in {r["name"] for r in self.conn.execute("PRAGMA table_info(dt_changes)")}:
                self.conn.execute("ALTER TABLE dt_changes ADD COLUMN domain TEXT")
            self.conn.execute("DROP INDEX IF EXISTS ix_changes_record")
            self.conn.execute("UPDATE dt_changes SET domain = ?", (LEGACY_DOMAIN,))
            if self.conn.execute("PRAGMA foreign_key_check").fetchone():
                raise RuntimeError("迁移后外键检查失败")
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise
        finally:
            self.conn.execute("PRAGMA foreign_keys=ON")

    @contextmanager
    def read(self):
        with self.lock:
            yield self.conn

    @contextmanager
    def tx(self, actor: str, *, suppress_bindings: bool = False):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                tx = Tx(self.conn, actor, suppress_bindings=suppress_bindings)
                yield tx
                tx.flush()
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            self.conn.execute("COMMIT")
        for fn in self.listeners:
            fn()
