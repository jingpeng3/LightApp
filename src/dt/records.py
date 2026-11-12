"""记录的增删改查：嵌套插入、级联删除、子表带出，每次修改都记进 dt_changes。"""

import json

from dt.db import Tx, dumps
from dt.errors import DtError, not_found
from dt.fields import normalize
from dt.model import Table, get_table, list_tables
from dt.query import compile_sort, compile_where

SYSTEM = {
    "_id": "id", "_parent_id": "parent_id", "_version": "version",
    "_created_at": "created_at", "_updated_at": "updated_at",
    "_created_by": "created_by", "_updated_by": "updated_by",
}


def to_output(table: Table, row) -> dict:
    data = json.loads(row["data"])
    out = {k: row[c] for k, c in SYSTEM.items()}
    for f in table.active_fields:
        value = data.get(f.key)
        out[f.key] = False if value is None and f.type == "checkbox" else value
    return out


def _fetch(conn, table: Table, record_id):
    row = conn.execute("SELECT * FROM dt_records WHERE id = ? AND table_id = ?", (record_id, table.id)).fetchone()
    if row is None:
        raise not_found(f"{table.name} 记录 {record_id}", f"用 dt rec query {table.name} 查找记录 id")
    return row


def _as_id(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).isdigit():
        raise DtError("invalid_value", f"{what} {value!r} 不是记录 id")
    return int(value)


def _check_parent(conn, table: Table, parent_id):
    if table.parent_id is None:
        if parent_id is not None:
            raise DtError("invalid_value", f"表 {table.name} 不是子表，不能指定父记录")
        return
    if parent_id is None:
        raise DtError(
            "parent_required", f"{table.name} 是 {table.parent} 的子表，需要指定父记录",
            f"用 --parent <{table.parent} 的 _id>，或者在插入 {table.parent} 时把 {table.name} 嵌套写进 data",
        )
    parent = get_table(conn, table.domain_id, table.parent)
    _fetch(conn, parent, parent_id)
    if table.relation == "one_to_one":
        row = conn.execute("SELECT id FROM dt_records WHERE table_id = ? AND parent_id = ?", (table.id, parent_id)).fetchone()
        if row:
            raise DtError(
                "one_to_one_conflict", f"{table.parent} 记录 {parent_id} 已有 {table.name} 记录 {row['id']}",
                f"{table.name} 是一对一子表，用 dt rec update {table.name} {row['id']} 修改", status=409,
            )


def _normalize_set(tx: Tx, table: Table, data: dict, prev: dict) -> dict:
    out = {}
    for key, value in data.items():
        f = table.field(key)
        if f is None:
            if key in SYSTEM:
                raise DtError("readonly_field", f"{key} 是只读系统字段", "系统字段由服务端维护，不要写入")
            if key in table.children:
                raise DtError("invalid_value", f"{key} 是子表", f"子表记录用 dt rec insert {key} --parent <id> 或 dt rec update {key} <id> 修改")
            keys = "、".join(x.key for x in table.active_fields)
            raise DtError("unknown_field", f"表 {table.name} 没有字段 {key}", f"可用字段：{keys}；用 dt table show {table.name} 查看定义")
        out[key] = normalize(f, value, conn=tx.conn, domain_id=table.domain_id, actor=tx.actor, ts=tx.ts, prev=prev.get(key))
    return out


def _check_unique(conn, table: Table, values: dict, exclude_id=None):
    for f in table.active_fields:
        value = values.get(f.key)
        if not f.unique or value is None:
            continue
        sql = f"SELECT id FROM dt_records WHERE table_id = ? AND json_extract(data, '$.{f.key}') = ?"
        params = [table.id, value]
        if exclude_id is not None:
            sql += " AND id != ?"
            params.append(exclude_id)
        row = conn.execute(sql, params).fetchone()
        if row:
            raise DtError("unique_violation", f"字段 {f.key} 的值 {value!r} 已被记录 {row['id']} 使用", f"{f.key} 要求唯一", status=409)


def _next_number(tx: Tx, table: Table, key: str) -> int:
    return tx.execute(
        "INSERT INTO dt_counters (table_id, field_key, value) VALUES (?, ?, 1)"
        " ON CONFLICT (table_id, field_key) DO UPDATE SET value = value + 1 RETURNING value",
        (table.id, key),
    ).fetchone()[0]


def insert(tx: Tx, table: Table, data, parent_id=None) -> dict:
    if not isinstance(data, dict):
        raise DtError("invalid_value", f"{table.name} 的 data 必须是 JSON 对象")
    data = dict(data)
    if "_parent_id" in data:
        pid = data.pop("_parent_id")
        if parent_id is not None and pid != parent_id:
            raise DtError("invalid_value", "_parent_id 和 --parent 不一致")
        parent_id = pid
    if parent_id is not None:
        parent_id = _as_id(parent_id, "父记录 id")
    nested = {k: data.pop(k) for k in list(data) if k in table.children}
    _check_parent(tx.conn, table, parent_id)
    values = _normalize_set(tx, table, data, {})
    for f in table.active_fields:
        if f.type == "auto_number":
            values[f.key] = _next_number(tx, table, f.key)
        elif f.key not in data and f.default is not None:
            values[f.key] = f.default
        if f.required and values.get(f.key) is None:
            raise DtError("required", f"{table.name} 的字段 {f.key} 必填", f"在 data 里提供 {f.key}")
    values = {k: v for k, v in values.items() if v is not None}
    _check_unique(tx.conn, table, values)
    cur = tx.execute(
        "INSERT INTO dt_records (table_id, parent_id, data, created_by, updated_by, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (table.id, parent_id, dumps(values), tx.actor, tx.actor, tx.ts, tx.ts),
    )
    record = to_output(table, _fetch(tx.conn, table, cur.lastrowid))
    tx.log(table.name, record["_id"], "insert", None, record)
    result = dict(record)
    for name, value in nested.items():
        child = get_table(tx.conn, table.domain_id, name)
        if child.relation == "one_to_one":
            result[name] = None if value is None else insert(tx, child, value, record["_id"])
        else:
            if not isinstance(value, list):
                raise DtError("invalid_value", f"子表 {name} 是一对多，嵌套写入时要传数组")
            result[name] = [insert(tx, child, v, record["_id"]) for v in value]
    return result


def insert_many(tx: Tx, table: Table, rows, parent_id=None) -> list[dict]:
    if not isinstance(rows, list):
        raise DtError("invalid_value", "批量插入需要记录数组")
    out = []
    for i, row in enumerate(rows):
        try:
            out.append(insert(tx, table, row, parent_id))
        except DtError as e:
            e.message = f"第 {i + 1} 条：{e.message}"
            raise
    return out


def write_data(tx: Tx, table: Table, row, data: dict) -> dict:
    """用新的 data 覆盖记录；没有实际变化时不升版本、不记 change。"""
    before = to_output(table, row)
    if data == json.loads(row["data"]):
        return before
    tx.execute(
        "UPDATE dt_records SET data = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?",
        (dumps(data), tx.actor, tx.ts, row["id"]),
    )
    after = to_output(table, _fetch(tx.conn, table, row["id"]))
    tx.log(table.name, row["id"], "update", before, after)
    return after


def update(tx: Tx, table: Table, record_id, values, if_version=None) -> dict:
    row = _fetch(tx.conn, table, record_id)
    if if_version is not None and row["version"] != if_version:
        raise DtError(
            "version_conflict", f"记录 {record_id} 当前版本是 {row['version']}，不是 {if_version}",
            f"先用 dt rec get {table.name} {record_id} 读取最新数据，再决定怎么改", status=409,
        )
    if not isinstance(values, dict) or not values:
        raise DtError("invalid_value", "--set 需要一个非空 JSON 对象")
    data = json.loads(row["data"])
    changed = _normalize_set(tx, table, values, data)
    for key, value in changed.items():
        if value is None and table.field(key).required:
            raise DtError("required", f"{table.name} 的字段 {key} 必填，不能清空")
    _check_unique(tx.conn, table, changed, exclude_id=row["id"])
    merged = {k: v for k, v in {**data, **changed}.items() if v is not None}
    return write_data(tx, table, row, merged)


def attach(tx: Tx, table: Table, record_id, key: str, paths) -> dict:
    f = table.field(key)
    if f is None or f.type != "attachment":
        raise DtError("invalid_value", f"{table.name} 的 {key} 不是附件字段")
    if not isinstance(paths, list) or not paths:
        raise DtError("invalid_value", "至少提供一个路径")
    current = json.loads(_fetch(tx.conn, table, record_id)["data"]).get(key)
    if f.config.get("multiple"):
        existing = current or []
        known = {item["path"] for item in existing}
        value = existing + [p for p in paths if p not in known]
    else:
        if current or len(paths) > 1:
            raise DtError("invalid_value", f"字段 {key} 只能有一个附件", f"替换附件用 dt rec update {table.name} {record_id} --set '{{\"{key}\": \"/abs/path\"}}'")
        value = paths[0]
    return update(tx, table, record_id, {key: value})


def delete(tx: Tx, table: Table, record_id) -> dict:
    """unlinked 是因为引用了被删记录而被改掉 link 字段、自己没被删的记录。"""
    deleted, unlinked = [], []
    _delete_tree(tx, table, _fetch(tx.conn, table, record_id), deleted, unlinked)
    gone = {d["_id"] for d in deleted}
    return {"deleted": deleted, "unlinked": [u for u in unlinked if u["_id"] not in gone]}


def _delete_tree(tx: Tx, table: Table, row, deleted: list, unlinked: list):
    for name in table.children:
        child = get_table(tx.conn, table.domain_id, name)
        rows = tx.execute("SELECT * FROM dt_records WHERE table_id = ? AND parent_id = ?", (child.id, row["id"])).fetchall()
        if rows and child.on_delete == "restrict":
            raise DtError(
                "restrict_violation", f"{table.name} 记录 {row['id']} 还有 {len(rows)} 条 {name} 子记录",
                f"{name} 设置了 on_delete: restrict，先删除这些子记录", status=409,
            )
        for r in rows:
            _delete_tree(tx, child, r, deleted, unlinked)
    tx.execute("DELETE FROM dt_records WHERE id = ?", (row["id"],))
    tx.log(table.name, row["id"], "delete", to_output(table, row), None)
    deleted.append({"table": table.name, "_id": row["id"]})
    _unlink(tx, table, row["id"], unlinked)


def _unlink(tx: Tx, table: Table, record_id: int, unlinked: list):
    """从其他表的 link 字段里去掉已删除的记录 id。"""
    for other in list_tables(tx.conn, table.domain_id):
        for f in other.active_fields:
            if f.type != "link" or f.config["table"] != table.name:
                continue
            rows = tx.execute(
                f"SELECT * FROM dt_records WHERE table_id = ? AND (json_extract(data, '$.{f.key}') = ?"
                f" OR EXISTS (SELECT 1 FROM json_each(data, '$.{f.key}') je WHERE je.value = ?))",
                (other.id, record_id, record_id),
            ).fetchall()
            for r in rows:
                data = json.loads(r["data"])
                value = data[f.key]
                value = [v for v in value if v != record_id] if isinstance(value, list) else None
                if value:
                    data[f.key] = value
                else:
                    data.pop(f.key)
                write_data(tx, other, r, data)
                unlinked.append({"table": other.name, "_id": r["id"], "field": f.key, "target": record_id})


def parse_include(include) -> dict:
    """"a,a.b,c" → {"a": {"b": {}}, "c": {}}"""
    tree: dict = {}
    for path in (include or "").split(","):
        node = tree
        for part in filter(None, path.strip().split(".")):
            node = node.setdefault(part, {})
    return tree


def _include_children(conn, table: Table, records: list[dict], tree: dict):
    for name, sub in tree.items():
        if name not in table.children:
            raise DtError("invalid_query", f"{name} 不是 {table.name} 的子表", "子表：" + ("、".join(table.children) or "无"))
        child = get_table(conn, table.domain_id, name)
        groups: dict[int, list] = {}
        ids = [r["_id"] for r in records]
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            marks = ",".join("?" * len(chunk))
            for row in conn.execute(
                f"SELECT * FROM dt_records WHERE table_id = ? AND parent_id IN ({marks}) ORDER BY id", (child.id, *chunk)
            ):
                groups.setdefault(row["parent_id"], []).append(to_output(child, row))
        _include_children(conn, child, [r for rs in groups.values() for r in rs], sub)
        for r in records:
            items = groups.get(r["_id"], [])
            r[name] = (items[0] if items else None) if child.relation == "one_to_one" else items


def get(conn, table: Table, record_id, include=None) -> dict:
    record = to_output(table, _fetch(conn, table, record_id))
    _include_children(conn, table, [record], parse_include(include))
    return record


def query(conn, table: Table, where=None, sort=None, limit=100, offset=0, include=None, parent_id=None) -> dict:
    if not 1 <= limit <= 1000:
        raise DtError("invalid_query", "limit 要在 1 到 1000 之间")
    if offset < 0:
        raise DtError("invalid_query", "offset 不能是负数")
    cond, params = compile_where(table, where or {})
    if parent_id is not None:
        cond += " AND r.parent_id = ?"
        params.append(parent_id)
    base = f"FROM dt_records r WHERE r.table_id = ? AND {cond}"
    total = conn.execute(f"SELECT COUNT(*) {base}", (table.id, *params)).fetchone()[0]
    rows = conn.execute(
        f"SELECT r.* {base} ORDER BY {compile_sort(table, sort)} LIMIT ? OFFSET ?", (table.id, *params, limit, offset)
    ).fetchall()
    items = [to_output(table, r) for r in rows]
    _include_children(conn, table, items, parse_include(include))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


DOMAIN_OPS = ("create_domain", "alter_domain", "drop_domain")


def list_changes(conn, domain=None, table_name=None, record_id=None, since=None, limit=100, domain_ops=False) -> list[dict]:
    """domain_ops=True 时，其他域的建域、改域、删域事件也一起返回（页面要据此刷新域列表）。"""
    cond, params = ["1 = 1"], []
    if domain is not None:
        marks = ",".join("?" * len(DOMAIN_OPS))
        cond.append(f"(domain = ? OR op IN ({marks}))" if domain_ops else "domain = ?")
        params += [domain, *DOMAIN_OPS] if domain_ops else [domain]
    if table_name:
        cond.append("table_name = ?")
        params.append(table_name)
    if record_id is not None:
        cond.append("record_id = ?")
        params.append(record_id)
    where = " AND ".join(cond)
    if since is not None:
        sql = f"SELECT * FROM dt_changes WHERE {where} AND seq > ? ORDER BY seq LIMIT ?"
        params += [since, limit]
    else:
        sql = f"SELECT * FROM (SELECT * FROM dt_changes WHERE {where} ORDER BY seq DESC LIMIT ?) ORDER BY seq"
        params.append(limit)
    return [
        {
            **dict(r),
            "before": json.loads(r["before"]) if r["before"] else None,
            "after": json.loads(r["after"]) if r["after"] else None,
            "fields": json.loads(r["fields"]) if r["fields"] else None,
        }
        for r in conn.execute(sql, params)
    ]
