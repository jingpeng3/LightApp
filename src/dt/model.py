import json
from dataclasses import dataclass, field as dc_field
from typing import Any

from dt.errors import not_found


@dataclass
class Field:
    key: str
    type: str
    label: str | None = None
    description: str | None = None
    required: bool = False
    unique: bool = False
    default: Any = None
    options: list[dict] | None = None
    config: dict = dc_field(default_factory=dict)
    archived: bool = False
    id: int | None = None

    @property
    def is_array(self) -> bool:
        if self.type == "multi_select":
            return True
        return self.type in ("link", "attachment") and bool(self.config.get("multiple"))

    def option_values(self) -> list[str]:
        return [o["value"] for o in self.options or []]


@dataclass
class Table:
    id: int
    domain_id: int
    name: str
    label: str | None
    description: str | None
    parent_id: int | None
    parent: str | None
    relation: str
    on_delete: str
    schema_version: int
    fields: list[Field]  # 包含已归档字段，按 position 排序
    children: list[str]

    @property
    def active_fields(self) -> list[Field]:
        return [f for f in self.fields if not f.archived]

    def field(self, key: str) -> Field | None:
        return next((f for f in self.active_fields if f.key == key), None)


def _loads(text):
    return None if text is None else json.loads(text)


def _field_from_row(row) -> Field:
    return Field(
        id=row["id"],
        key=row["key"],
        type=row["type"],
        label=row["label"],
        description=row["description"],
        required=bool(row["required"]),
        unique=bool(row["uniq"]),
        default=_loads(row["default_value"]),
        options=_loads(row["options"]),
        config=_loads(row["config"]) or {},
        archived=bool(row["archived"]),
    )


def _table_from_row(conn, row) -> Table:
    fields = [
        _field_from_row(r)
        for r in conn.execute("SELECT * FROM dt_fields WHERE table_id = ? ORDER BY position, id", (row["id"],))
    ]
    children = [r["name"] for r in conn.execute("SELECT name FROM dt_tables WHERE parent_id = ? ORDER BY id", (row["id"],))]
    parent = None
    if row["parent_id"] is not None:
        parent = conn.execute("SELECT name FROM dt_tables WHERE id = ?", (row["parent_id"],)).fetchone()["name"]
    return Table(
        id=row["id"],
        domain_id=row["domain_id"],
        name=row["name"],
        label=row["label"],
        description=row["description"],
        parent_id=row["parent_id"],
        parent=parent,
        relation=row["relation"],
        on_delete=row["on_delete"],
        schema_version=row["schema_version"],
        fields=fields,
        children=children,
    )


def load_table(conn, domain_id: int | None, name: str) -> Table | None:
    if domain_id is None:
        return None
    row = conn.execute("SELECT * FROM dt_tables WHERE domain_id = ? AND name = ?", (domain_id, name)).fetchone()
    return _table_from_row(conn, row) if row else None


def get_table(conn, domain_id: int | None, name: str) -> Table:
    table = load_table(conn, domain_id, name)
    if table is None:
        raise not_found(f"表 {name}", "用 dt table list 查看当前域里的表")
    return table


def table_by_id(conn, table_id: int) -> Table:
    return _table_from_row(conn, conn.execute("SELECT * FROM dt_tables WHERE id = ?", (table_id,)).fetchone())


def list_tables(conn, domain_id: int) -> list[Table]:
    return [_table_from_row(conn, r) for r in conn.execute("SELECT * FROM dt_tables WHERE domain_id = ? ORDER BY id", (domain_id,))]


def get_domain(conn, name: str) -> dict:
    row = conn.execute("SELECT * FROM dt_domains WHERE name = ?", (name,)).fetchone()
    if row is None:
        names = [r[0] for r in conn.execute("SELECT name FROM dt_domains ORDER BY id")]
        hint = ("已有的域：" + "、".join(names)) if names else "还没有域，用 dt domain create <name> 或 dt domain apply 创建"
        raise not_found(f"域 {name}", hint)
    return dict(row)


def bind_domain(tx, name: str) -> dict:
    """让这个写事务作用在某个域上：之后的 change 都记到这个域。"""
    d = get_domain(tx.conn, name)
    tx.domain, tx.domain_id = d["name"], d["id"]
    return d
