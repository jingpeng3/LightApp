"""命名视图：一张表上存下来的一组查询条件和排序，页面侧栏和 dt rec query --view 共用。"""

import json

from dt.db import dumps
from dt.errors import DtError, not_found
from dt.model import Table, bind_domain, get_table, table_by_id
from dt.query import compile_sort, compile_where


def _out(table_name: str, row) -> dict:
    return {
        "id": row["id"], "table": table_name, "name": row["name"], "description": row["description"],
        "where": json.loads(row["where_expr"]) if row["where_expr"] else None, "sort": row["sort"],
        "created_by": row["created_by"], "updated_by": row["updated_by"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
    }


def list_views(conn, domain_id: int, table: str | None = None) -> list[dict]:
    sql = ("SELECT v.*, t.name AS table_name FROM dt_views v JOIN dt_tables t ON t.id = v.table_id"
           " WHERE t.domain_id = ?")
    params: list = [domain_id]
    if table:
        sql += " AND t.name = ?"
        params.append(table)
    return [_out(r["table_name"], r) for r in conn.execute(sql + " ORDER BY t.id, v.id", params)]


def find(conn, table: Table, name: str) -> dict:
    row = conn.execute("SELECT * FROM dt_views WHERE table_id = ? AND name = ?", (table.id, name)).fetchone()
    if row is None:
        names = [r[0] for r in conn.execute("SELECT name FROM dt_views WHERE table_id = ? ORDER BY id", (table.id,))]
        raise not_found(f"表 {table.name} 的视图 {name}", ("已有的视图：" + "、".join(names)) if names else "这张表还没有视图，用 dt view save 创建")
    return _out(table.name, row)


def merge(view: dict, where, sort):
    """视图的条件和调用方额外给的条件同时满足；调用方给了排序就用调用方的。"""
    conds = [w for w in (view["where"], where) if w]
    merged = None if not conds else conds[0] if len(conds) == 1 else {"$and": conds}
    return merged, sort or view["sort"]


def _check(conn, table: Table, body: dict) -> dict:
    out = {}
    if "name" in body:
        name = body["name"]
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60:
            raise DtError("invalid_value", "视图名要是 1 到 60 个字的字符串")
        out["name"] = name.strip()
    if "description" in body:
        if body["description"] is not None and not isinstance(body["description"], str):
            raise DtError("invalid_value", "description 要是字符串")
        out["description"] = body["description"] or None
    if "where" in body:
        where = body["where"] or None
        if where is not None:
            compile_where(table, where, conn)  # 提前报出字段、运算符写错
        out["where_expr"] = None if where is None else dumps(where)
    if "sort" in body:
        sort = body["sort"] or None
        if sort is not None:
            if not isinstance(sort, str):
                raise DtError("invalid_value", "sort 要是字符串，如 -_updated_at,title")
            compile_sort(table, sort)
        out["sort"] = sort
    return out


def save(db, domain: str, body: dict, *, actor: str) -> dict:
    """按（表，名字）保存：不存在就新建，存在就整体覆盖条件和排序。"""
    if not isinstance(body.get("table"), str):
        raise DtError("invalid_value", "缺少 table")
    if "name" not in body:
        raise DtError("invalid_value", "缺少 name")
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        table = get_table(tx.conn, tx.domain_id, body["table"])
        values = _check(tx.conn, table, {"where": None, "sort": None, "description": None, **body})
        row = tx.execute("SELECT * FROM dt_views WHERE table_id = ? AND name = ?", (table.id, values["name"])).fetchone()
        if row is None:
            vid = tx.execute(
                "INSERT INTO dt_views (table_id, name, description, where_expr, sort, created_by, updated_by, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (table.id, values["name"], values["description"], values["where_expr"], values["sort"], tx.actor, tx.actor, tx.ts, tx.ts),
            ).lastrowid
            before = None
        else:
            vid = row["id"]
            before = _out(table.name, row)
            tx.execute(
                "UPDATE dt_views SET description = ?, where_expr = ?, sort = ?, updated_by = ?, updated_at = ? WHERE id = ?",
                (values["description"], values["where_expr"], values["sort"], tx.actor, tx.ts, vid),
            )
        after = _out(table.name, tx.execute("SELECT * FROM dt_views WHERE id = ?", (vid,)).fetchone())
        tx.log(table.name, None, "create_view" if before is None else "alter_view", before, after)
    return after


def _row(tx, view_id: int):
    row = tx.execute(
        "SELECT v.* FROM dt_views v JOIN dt_tables t ON t.id = v.table_id WHERE v.id = ? AND t.domain_id = ?", (view_id, tx.domain_id)
    ).fetchone()
    if row is None:
        raise not_found(f"视图 {view_id}", "用 dt view list 查看已有的视图")
    return row


def update(db, domain: str, view_id: int, body: dict, *, actor: str) -> dict:
    """只改传了的项：name、description、where、sort。"""
    unknown = set(body) - {"name", "description", "where", "sort"}
    if unknown or not body:
        raise DtError("invalid_value", f"不能修改 {sorted(unknown)}" if unknown else "没有要修改的项", "可以改 name、description、where、sort")
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        row = _row(tx, view_id)
        table = table_by_id(tx.conn, row["table_id"])
        values = _check(tx.conn, table, body)
        if "name" in values and tx.execute(
            "SELECT 1 FROM dt_views WHERE table_id = ? AND name = ? AND id != ?", (table.id, values["name"], view_id)
        ).fetchone():
            raise DtError("conflict", f"表 {table.name} 已经有叫 {values['name']} 的视图", status=409)
        sets = ", ".join(f"{k} = ?" for k in values)
        tx.execute(f"UPDATE dt_views SET {sets}, updated_by = ?, updated_at = ? WHERE id = ?", (*values.values(), tx.actor, tx.ts, view_id))
        after = _out(table.name, tx.execute("SELECT * FROM dt_views WHERE id = ?", (view_id,)).fetchone())
        tx.log(table.name, None, "alter_view", _out(table.name, row), after)
    return after


def delete(db, domain: str, view_id: int, *, actor: str) -> dict:
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        row = _row(tx, view_id)
        table = table_by_id(tx.conn, row["table_id"])
        tx.execute("DELETE FROM dt_views WHERE id = ?", (view_id,))
        tx.log(table.name, None, "drop_view", _out(table.name, row), None)
    return {"deleted": view_id}
