"""域：一组表的命名空间。表名在域内唯一，link 只能引用同一个域里的表。"""

from dt.db import Tx
from dt.errors import DtError
from dt.model import bind_domain, get_domain, list_tables
from dt.schema import NAME_RE, Step, _err, _execute, _subtree, delete_tables, parse_spec, plan, spec_warnings, table_summary

DOMAIN_KEYS = {"name", "label", "description", "tables"}


def _check_name(name) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise _err(f"域名 {name!r} 不合法", "只能用小写字母、数字和下划线，以字母开头，最长 63 个字符")
    return name


def _text(raw: dict, key: str):
    value = raw.get(key)
    if value is not None and not isinstance(value, str):
        raise _err(f"域的 {key} 必须是字符串")
    return value


def domain_to_dict(conn, d: dict, *, tables: bool = False) -> dict:
    out = {"name": d["name"], "label": d["label"], "description": d["description"]}
    tbls = list_tables(conn, d["id"])
    out["table_count"] = len(tbls)
    out["record_count"] = conn.execute(
        "SELECT COUNT(*) FROM dt_records r JOIN dt_tables t ON t.id = r.table_id WHERE t.domain_id = ?", (d["id"],)
    ).fetchone()[0]
    if tables:
        out["tables"] = [table_summary(conn, t) for t in tbls if t.parent is None]
    return out


def list_domains(conn) -> list[dict]:
    return [domain_to_dict(conn, dict(r)) for r in conn.execute("SELECT * FROM dt_domains ORDER BY id")]


def show(conn, name: str) -> dict:
    return domain_to_dict(conn, get_domain(conn, name), tables=True)


def _insert(tx: Tx, name: str, label, description):
    tx.domain = name
    tx.domain_id = tx.execute(
        "INSERT INTO dt_domains (name, label, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (name, label, description, tx.ts, tx.ts),
    ).lastrowid
    tx.log("", None, "create_domain", None, {"name": name, "label": label, "description": description})


def create(db, raw: dict, *, actor: str = "cli") -> dict:
    name = _check_name(raw.get("name"))
    unknown = set(raw) - (DOMAIN_KEYS - {"tables"})
    if unknown:
        raise _err(f"域有未知属性 {sorted(unknown)}", "可用属性：name、label、description")
    with db.tx(actor) as tx:
        if tx.execute("SELECT 1 FROM dt_domains WHERE name = ?", (name,)).fetchone():
            raise DtError("already_exists", f"域 {name} 已存在", "改域的显示名或表结构用 dt domain apply", status=409)
        _insert(tx, name, _text(raw, "label"), _text(raw, "description"))
        return domain_to_dict(tx.conn, get_domain(tx.conn, name))


def _parse(raw):
    if not isinstance(raw, dict):
        raise _err("域模版必须是对象", "顶层写 name、label、tables")
    name = _check_name(raw.get("name"))
    unknown = set(raw) - DOMAIN_KEYS
    if unknown:
        raise _err(f"域 {name} 有未知属性 {sorted(unknown)}", "可用属性：" + "、".join(sorted(DOMAIN_KEYS)))
    tables_raw = raw.get("tables") or []
    if not isinstance(tables_raw, list):
        raise _err(f"域 {name} 的 tables 必须是数组")
    specs = [parse_spec(t) for t in tables_raw]
    for s in specs:
        if s.parent is not None:
            raise _err(f"域模版里的表 {s.name} 不能写 parent", "子表请用 children 嵌套在父表下面")
    return name, _text(raw, "label"), _text(raw, "description"), specs


def _plan(conn, raw) -> tuple[str, list[Step], list[str]]:
    name, label, description, specs = _parse(raw)
    warnings = ([] if description else [f"域 {name} 没有 description"]) + spec_warnings(specs)
    row = conn.execute("SELECT * FROM dt_domains WHERE name = ?", (name,)).fetchone()
    steps: list[Step] = []
    if row is None:
        steps.append(Step("create_domain", name, f"新建域，{len(specs)} 张顶层表",
                          run=lambda tx: _insert(tx, name, label, description)))
        did = None
    else:
        did = row["id"]
        changes = [f"{k}: {row[k]!r} → {v!r}" for k, v in (("label", label), ("description", description)) if row[k] != v]
        if changes:
            steps.append(Step("update_domain", name, "；".join(changes), run=lambda tx: tx.execute(
                "UPDATE dt_domains SET label = ?, description = ?, updated_at = ? WHERE id = ?", (label, description, tx.ts, did))))
    steps += plan(conn, did, specs)
    if did is not None:
        spec_roots = {s.name for s in specs}
        for t in list_tables(conn, did):
            if t.parent is None and t.name not in spec_roots:
                steps.append(Step("keep_table", t.name, f"表不在域模版里，保持不变；要删除请用 dt table drop {t.name} -D {name} --force"))
    return name, steps, warnings


def apply(db, raw, *, dry_run: bool = False, force: bool = False, actor: str = "cli") -> dict:
    """声明式应用一整个域：域不存在就创建，然后逐张 apply 里面的表。"""
    if dry_run:
        with db.read() as conn:
            _, steps, warnings = _plan(conn, raw)
        return {"applied": False, "plan": [s.to_dict() for s in steps], "warnings": warnings}
    with db.tx(actor) as tx:
        name, steps, warnings = _plan(tx.conn, raw)
        if tx.conn.execute("SELECT 1 FROM dt_domains WHERE name = ?", (name,)).fetchone():
            bind_domain(tx, name)
        _execute(tx, steps, force)
        result = domain_to_dict(tx.conn, get_domain(tx.conn, name), tables=True)
    return {"applied": True, "plan": [s.to_dict() for s in steps], "domain": result, "warnings": warnings}


def drop(db, name: str, *, force: bool = False, actor: str = "cli") -> dict:
    with db.tx(actor) as tx:
        d = bind_domain(tx, name)
        tables = [t for root in list_tables(tx.conn, d["id"]) if root.parent is None for t in _subtree(tx.conn, root, [])]
        counts = {t.name: tx.execute("SELECT COUNT(*) FROM dt_records WHERE table_id = ?", (t.id,)).fetchone()[0] for t in tables}
        if not force:
            raise DtError("destructive_change", f"将删除域 {name}：{len(tables)} 张表、{sum(counts.values())} 条记录，未执行",
                          "确认后加 --force", status=409, details={"tables": counts})
        delete_tables(tx, tables, counts)
        tx.execute("DELETE FROM dt_domains WHERE id = ?", (d["id"],))
        tx.log("", None, "drop_domain", {"name": name, "tables": counts}, None)
    return {"dropped": name, "tables": counts}
