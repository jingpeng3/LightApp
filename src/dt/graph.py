"""知识图谱：记录是节点，父子关系和 link 字段是边，再附上每个操作者改过哪些记录。"""

import json
from collections import Counter

from dt.errors import not_found
from dt.model import Table, list_tables


def _title(table: Table, data: dict, record_id: int) -> str:
    """和页面的 recTitle 一致：第一个有值的文本字段，否则 #id。"""
    for f in table.active_fields:
        if f.type in ("text", "long_text") and data.get(f.key):
            return str(data[f.key])[:80]
    return f"#{record_id}"


def _ids(value) -> list:
    return value if isinstance(value, list) else [] if value is None else [value]


def build(conn, domain: str, domain_id: int, tables: list[str] | None = None, limit: int = 3000) -> dict:
    """tables 为 None 表示整个域；记录超过 limit 时只保留最近更新的。table_edges 总是统计整个域。"""
    all_tables = list_tables(conn, domain_id)
    by_id = {t.id: t for t in all_tables}
    if tables is not None:
        missing = set(tables) - {t.name for t in all_tables}
        if missing:
            raise not_found(f"表 {'、'.join(sorted(missing))}", "用 dt table list 查看当前域里的表")
    scope = {t.id for t in all_tables if tables is None or t.name in tables}
    seq = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]

    rows = conn.execute(
        "SELECT r.* FROM dt_records r JOIN dt_tables t ON t.id = r.table_id"
        " WHERE t.domain_id = ? ORDER BY r.updated_at DESC, r.id DESC",
        (domain_id,),
    ).fetchall()
    table_edges: Counter = Counter()
    picked, in_scope = [], 0
    for r in rows:
        table = by_id[r["table_id"]]
        data = json.loads(r["data"])
        if r["parent_id"] is not None:
            table_edges[(table.parent, table.name, "parent", None)] += 1
        for f in table.active_fields:
            if f.type == "link":
                n = len(_ids(data.get(f.key)))
                if n:
                    table_edges[(table.name, f.config["table"], "link", f.key)] += n
        if r["table_id"] in scope:
            in_scope += 1
            if len(picked) < limit:
                picked.append((table, r, data))

    nodes, edges = [], []
    ids = {r["id"] for _, r, _ in picked}
    for table, r, data in picked:
        nodes.append({
            "id": r["id"], "table": table.name, "title": _title(table, data, r["id"]), "parent_id": r["parent_id"],
            "created_by": r["created_by"], "updated_by": r["updated_by"], "updated_at": r["updated_at"],
        })
        if r["parent_id"] in ids:
            edges.append({"source": r["parent_id"], "target": r["id"], "kind": "parent"})
        for f in table.active_fields:
            if f.type == "link":
                for target in _ids(data.get(f.key)):
                    if target in ids:
                        edges.append({"source": r["id"], "target": target, "kind": "link", "field": f.key})

    touches = []
    names = [t.name for t in all_tables if t.id in scope]
    if ids and names:
        marks = ",".join("?" * len(names))
        for row in conn.execute(
            "SELECT actor, record_id, COUNT(*) AS n FROM dt_changes"
            f" WHERE domain = ? AND table_name IN ({marks}) AND op IN ('insert', 'update') AND actor IS NOT NULL"
            " GROUP BY actor, record_id ORDER BY actor, record_id",
            (domain, *names),
        ):
            if row["record_id"] in ids:
                touches.append({"actor": row["actor"], "record_id": row["record_id"], "count": row["n"]})

    return {
        "seq": seq,
        "total": len(rows),
        "truncated": in_scope > limit,
        "nodes": nodes,
        "edges": edges,
        "touches": touches,
        "table_edges": [
            {"source": s, "target": t, "kind": k, **({"field": f} if f else {}), "count": n}
            for (s, t, k, f), n in table_edges.items()
        ],
    }
