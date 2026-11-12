"""知识图谱：记录是节点，父子关系和 link 字段是边，再附上每个操作者改过哪些记录。"""

import json
from collections import Counter, defaultdict, deque

from dt.errors import DtError, not_found
from dt.model import Table, list_tables
from dt.query import SYSTEM_COLUMNS, compile_where
from dt.records import to_output


def _title(table: Table, data: dict, record_id: int) -> str:
    """和页面的 recTitle 一致：第一个有值的文本字段，否则 #id。"""
    for f in table.active_fields:
        if f.type in ("text", "long_text") and data.get(f.key):
            return str(data[f.key])[:80]
    return f"#{record_id}"


def _ids(value) -> list:
    return value if isinstance(value, list) else [] if value is None else [value]


def _node(table: Table, r, data: dict) -> dict:
    return {
        "id": r["id"], "table": table.name, "title": _title(table, data, r["id"]), "parent_id": r["parent_id"],
        "created_by": r["created_by"], "updated_by": r["updated_by"], "updated_at": r["updated_at"],
    }


def _touches(conn, domain: str, names: list[str], ids, until: int | None = None) -> list[dict]:
    """每个操作者对 ids 里每条记录做过几次 insert / update；until 只统计 seq 不超过它的变更。"""
    if not ids or not names:
        return []
    marks = ",".join("?" * len(names))
    return [
        {"actor": row["actor"], "record_id": row["record_id"], "count": row["n"]}
        for row in conn.execute(
            "SELECT actor, record_id, COUNT(*) AS n FROM dt_changes"
            f" WHERE domain = ? AND table_name IN ({marks}) AND op IN ('insert', 'update') AND actor IS NOT NULL AND seq <= ?"
            " GROUP BY actor, record_id ORDER BY actor, record_id",
            (domain, *names, until if until is not None else 2**62),
        )
        if row["record_id"] in ids
    ]


def _rows_at(conn, domain: str, by_name: dict[str, Table], at: int) -> list[tuple]:
    """seq 为 at 时域里还在的记录，取每条记录在 at 之前最后一次变更的 after。按当前表结构解释，已删的表跳过。"""
    out = []
    for c in conn.execute(
        "SELECT c.table_name, c.record_id, c.op, c.after FROM dt_changes c JOIN ("
        " SELECT record_id, MAX(seq) AS s FROM dt_changes WHERE domain = ? AND seq <= ? AND record_id IS NOT NULL"
        " AND op IN ('insert', 'update', 'delete') GROUP BY record_id) m ON c.seq = m.s",
        (domain, at),
    ):
        table = by_name.get(c["table_name"])
        if c["op"] == "delete" or table is None:
            continue
        rec = json.loads(c["after"])
        out.append((table, {
            "id": c["record_id"], "parent_id": rec.get("_parent_id"), "created_by": rec.get("_created_by"),
            "updated_by": rec.get("_updated_by"), "updated_at": rec.get("_updated_at") or "",
        }, rec))
    out.sort(key=lambda x: (x[1]["updated_at"], x[1]["id"]), reverse=True)
    return out


def build(conn, domain: str, domain_id: int, tables: list[str] | None = None, limit: int = 3000, at: int | None = None) -> dict:
    """tables 为 None 表示整个域；记录超过 limit 时只保留最近更新的。table_edges 和 orphans 总是统计整个域。
    at 给出变更 seq 时，返回那一刻的图（由 dt_changes 还原），用于历史回放。"""
    all_tables = list_tables(conn, domain_id)
    by_id = {t.id: t for t in all_tables}
    if tables is not None:
        missing = set(tables) - {t.name for t in all_tables}
        if missing:
            raise not_found(f"表 {'、'.join(sorted(missing))}", "用 dt table list 查看当前域里的表")
    scope = {t.name for t in all_tables if tables is None or t.name in tables}
    seq = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]

    if at is None:
        rows = [
            (by_id[r["table_id"]], r, json.loads(r["data"]))
            for r in conn.execute(
                "SELECT r.* FROM dt_records r JOIN dt_tables t ON t.id = r.table_id"
                " WHERE t.domain_id = ? ORDER BY r.updated_at DESC, r.id DESC",
                (domain_id,),
            )
        ]
    else:
        rows = _rows_at(conn, domain, {t.name: t for t in all_tables}, at)
    table_of = {r["id"]: table.name for table, r, _ in rows}
    table_edges: Counter = Counter()
    linked: set = set()  # 有父子或有效 link 关系的记录，和 lint 的孤立判断一致
    picked, in_scope = [], 0
    for table, r, data in rows:
        if r["parent_id"] is not None:
            table_edges[(table.parent, table.name, "parent", None)] += 1
            linked |= {r["id"], r["parent_id"]}
        for f in table.active_fields:
            if f.type == "link":
                targets = _ids(data.get(f.key))
                if targets:
                    table_edges[(table.name, f.config["table"], "link", f.key)] += len(targets)
                for target in targets:
                    if table_of.get(target) == f.config["table"]:
                        linked |= {r["id"], target}
        if table.name in scope:
            in_scope += 1
            if len(picked) < limit:
                picked.append((table, r, data))
    orphans = Counter(table.name for table, r, _ in rows if r["id"] not in linked)

    nodes, edges = [], []
    ids = {r["id"] for _, r, _ in picked}
    for table, r, data in picked:
        nodes.append(_node(table, r, data))
        if r["parent_id"] in ids:
            edges.append({"source": r["parent_id"], "target": r["id"], "kind": "parent"})
        for f in table.active_fields:
            if f.type == "link":
                for target in _ids(data.get(f.key)):
                    if target in ids:
                        edges.append({"source": r["id"], "target": target, "kind": "link", "field": f.key})

    touches = _touches(conn, domain, sorted(scope), ids, at)

    out = {
        "seq": seq if at is None else at,
        "total": len(rows),
        "truncated": in_scope > limit,
        "nodes": nodes,
        "edges": edges,
        "touches": touches,
        "table_edges": [
            {"source": s, "target": t, "kind": k, **({"field": f} if f else {}), "count": n}
            for (s, t, k, f), n in table_edges.items()
        ],
        "orphans": dict(orphans),
    }
    if at is not None:
        first, last, ts = conn.execute(
            "SELECT MIN(seq), MAX(seq), (SELECT ts FROM dt_changes WHERE domain = ? AND seq <= ? ORDER BY seq DESC LIMIT 1)"
            " FROM dt_changes WHERE domain = ? AND record_id IS NOT NULL AND op IN ('insert', 'update', 'delete')",
            (domain, at, domain),
        ).fetchone()
        out["timeline"] = {"first_seq": first or 0, "last_seq": last or 0, "at_ts": ts}
    return out


# ---------- 关联查询、路径、检查、删除影响：都在整个域上算，不受 build 的 limit 影响 ----------

class Edge:
    __slots__ = ("source", "target", "kind", "field", "owner")

    def __init__(self, source: int, target: int, kind: str, field: str | None = None, owner: str | None = None):
        self.source, self.target, self.kind, self.field, self.owner = source, target, kind, field, owner

    @property
    def key(self) -> str:
        """和页面「连线」开关一致：parent 或 link:<持有表>.<字段>。"""
        return "parent" if self.kind == "parent" else f"link:{self.owner}.{self.field}"

    def to_dict(self) -> dict:
        return {"source": self.source, "target": self.target, "kind": self.kind, **({"field": self.field} if self.field else {})}


class Index:
    """一个域里全部记录和边。link 指向不存在（或不在目标表里）的记录时记进 dangling，不建边。"""

    def __init__(self, conn, domain_id: int):
        self.tables = list_tables(conn, domain_id)
        self.by_name = {t.name: t for t in self.tables}
        by_id = {t.id: t for t in self.tables}
        self.recs: dict[int, tuple[Table, object, dict]] = {}
        for r in conn.execute(
            "SELECT r.* FROM dt_records r JOIN dt_tables t ON t.id = r.table_id WHERE t.domain_id = ? ORDER BY r.id",
            (domain_id,),
        ):
            self.recs[r["id"]] = (by_id[r["table_id"]], r, json.loads(r["data"]))
        self.out: dict[int, list[Edge]] = defaultdict(list)
        self.inn: dict[int, list[Edge]] = defaultdict(list)
        self.dangling: list[dict] = []
        for rid, (table, r, data) in self.recs.items():
            if r["parent_id"] is not None:
                self._add(Edge(r["parent_id"], rid, "parent"))
            for f in table.active_fields:
                if f.type != "link":
                    continue
                for target in _ids(data.get(f.key)):
                    hit = self.recs.get(target)
                    if hit and hit[0].name == f.config["table"]:
                        self._add(Edge(rid, target, "link", f.key, table.name))
                    else:
                        self.dangling.append({**self.brief(rid), "field": f.key, "target": target, "target_table": f.config["table"]})

    def _add(self, e: Edge):
        self.out[e.source].append(e)
        self.inn[e.target].append(e)

    def node(self, rid: int) -> dict:
        return _node(*self.recs[rid])

    def brief(self, rid: int) -> dict:
        table, r, data = self.recs[rid]
        return {"table": table.name, "id": rid, "title": _title(table, data, rid)}

    def require(self, rid: int):
        if rid not in self.recs:
            raise not_found(f"记录 {rid}", "用 dt rec query <表> 查找记录 _id")

    def steps(self, rid: int, direction: str, kinds: set | None):
        """从 rid 出发能走的边：(边, 另一端, 方向)。out 沿边的方向走（父→子、引用方→被引用方），in 反着走。"""
        if direction in ("out", "both"):
            for e in self.out[rid]:
                if _passes(e, kinds):
                    yield e, e.target, "out"
        if direction in ("in", "both"):
            for e in self.inn[rid]:
                if _passes(e, kinds):
                    yield e, e.source, "in"

    def edges_among(self, ids, kinds: set | None) -> list[dict]:
        return [e.to_dict() for rid in ids for e in self.out[rid] if e.target in ids and _passes(e, kinds)]


def _passes(e: Edge, kinds: set | None) -> bool:
    return kinds is None or e.key in kinds or e.kind in kinds


def _where_keys(where) -> set:
    if not isinstance(where, dict):
        raise DtError("invalid_query", "where 必须是 JSON 对象")
    keys = set()
    for k, v in where.items():
        if k in ("$and", "$or"):
            for sub in v if isinstance(v, list) else [v]:
                keys |= _where_keys(sub)
        else:
            keys.add(k)
    return keys


def matching(conn, idx: Index, ids, where: dict, what: str = "where") -> set:
    """ids 里满足 where 的记录。记录分属多张表，表里缺 where 用到的字段时，这张表的记录都算不满足；
    所有表都缺时报错。"""
    by_table: dict[str, list[int]] = defaultdict(list)
    for rid in ids:
        by_table[idx.recs[rid][0].name].append(rid)
    keys = {k for k in _where_keys(where) if not k.startswith("$") and k not in SYSTEM_COLUMNS}
    usable = [name for name in by_table if all(idx.by_name[name].field(k) for k in keys)]
    if by_table and not usable:
        raise DtError("invalid_query", f"{what} 用到的字段 {'、'.join(sorted(keys))} 在这些记录的表（{'、'.join(sorted(by_table))}）里都没有",
                      "用 dt table show <表> 查看字段 key")
    hit = set()
    for name in usable:
        table = idx.by_name[name]
        cond, params = compile_where(table, where)
        hit |= {r[0] for r in conn.execute(
            f"SELECT r.id FROM dt_records r WHERE r.table_id = ? AND r.id IN (SELECT value FROM json_each(?)) AND {cond}",
            (table.id, json.dumps(by_table[name]), *params),
        )}
    return hit


def _changed_since(conn, domain: str, ids, since: int) -> dict[int, dict]:
    """since 之后 ids 里每条记录的 insert / update 汇总：次数、最后 seq 和时间、操作者、改过的字段。"""
    out: dict[int, dict] = {}
    for c in conn.execute(
        "SELECT seq, record_id, op, actor, ts FROM dt_changes WHERE domain = ? AND seq > ? AND op IN ('insert', 'update') ORDER BY seq",
        (domain, since),
    ):
        if c["record_id"] not in ids:
            continue
        s = out.setdefault(c["record_id"], {"count": 0, "last_seq": 0, "last_ts": None, "ops": [], "actors": [], "fields": []})
        s["count"] += 1
        s["last_seq"], s["last_ts"] = c["seq"], c["ts"]
        for key, value in (("ops", c["op"]), ("actors", c["actor"])):
            if value is not None and value not in s[key]:
                s[key].append(value)
    if out:
        for row in conn.execute(
            "SELECT DISTINCT c.record_id, f.field FROM dt_changes c JOIN dt_change_fields f ON f.seq = c.seq"
            " WHERE c.domain = ? AND c.seq > ? AND c.op = 'update' ORDER BY f.field",
            (domain, since),
        ):
            if row[0] in out:
                out[row[0]]["fields"].append(row[1])
    return out


def _data(idx: Index, rid: int, fields: list[str] | None) -> dict:
    """记录的完整数据（和 dt rec get 一样），fields 给出时只保留这些 key。"""
    table, r, _ = idx.recs[rid]
    rec = to_output(table, r)
    return rec if fields is None else {k: rec[k] for k in fields if k in rec}


DIRECTIONS = ("both", "out", "in")


def parse_kinds(value: str | None) -> set | None:
    """逗号分隔：parent、link（全部 link 字段）、link:<表>.<字段>。省略表示全部。"""
    if value is None:
        return None
    kinds = {x.strip() for x in value.split(",") if x.strip()}
    bad = [k for k in kinds if k not in ("parent", "link") and not k.startswith("link:")]
    if bad:
        raise DtError("invalid_query", f"不认识的连线类型 {bad}", "可用：parent、link、link:<表>.<字段>")
    return kinds


def _check_direction(direction: str):
    if direction not in DIRECTIONS:
        raise DtError("invalid_query", f"direction 只能是 {'、'.join(DIRECTIONS)}", "out 沿父→子、引用方→被引用方走，in 反过来，both 两个方向都走")


def _seq(conn) -> int:
    return conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]


def _depth(value) -> int | None:
    """跳数：非负整数，all 表示不限。"""
    if value in (None, "all"):
        return None
    if isinstance(value, int) or str(value).isdigit():
        return int(value)
    raise DtError("invalid_query", f"depth {value!r} 不是非负整数", "写 1、2、3…，或 all 表示不限跳数")


def _fields(value: str | None) -> list[str] | None | bool:
    """fields 参数：省略不带数据，* 带全部字段，a,b 只带这些字段。"""
    if value is None:
        return False
    return None if value.strip() == "*" else [x.strip() for x in value.split(",") if x.strip()]


def related(conn, domain: str, domain_id: int, ids: list[int], actor: str | None = None, depth=1,
            direction: str = "both", kinds: str | None = None, tables: list[str] | None = None, limit: int = 500,
            where: dict | None = None, since: int | None = None, fields: str | None = None) -> dict:
    """从一组起点出发按 BFS 找关联记录。actor 把它 insert / update 过、现在还在的记录也作为起点。
    每个节点带 depth（离最近起点几跳）和 via（第一次到达它走的那条边）；tables 限定只经过哪些表（起点不受限）。
    where / since 只筛选返回的记录，不影响遍历，起点总是保留；fields 给出时每个节点带 data。"""
    _check_direction(direction)
    if not ids and actor is None:
        raise DtError("invalid_query", "至少给一个起点", "传记录 _id，或者 actor=<操作者名字>")
    max_depth, ks = _depth(depth), parse_kinds(kinds)
    idx = Index(conn, domain_id)
    if tables is not None:
        missing = set(tables) - set(idx.by_name)
        if missing:
            raise not_found(f"表 {'、'.join(sorted(missing))}", "用 dt table list 查看当前域里的表")
    for rid in ids:
        idx.require(rid)
    seeds = list(dict.fromkeys(ids))
    if actor is not None:
        rows = conn.execute(
            "SELECT DISTINCT record_id FROM dt_changes WHERE domain = ? AND actor = ? AND op IN ('insert', 'update') ORDER BY record_id",
            (domain, actor),
        )
        seeds += [r[0] for r in rows if r[0] in idx.recs and r[0] not in seeds]

    found: dict[int, dict] = {}
    queue: deque = deque()
    truncated = False
    for rid in seeds:
        if len(found) >= limit:
            truncated = True
            break
        found[rid] = {**idx.node(rid), "depth": 0, "via": None}
        queue.append(rid)
    while queue and not truncated:
        rid = queue.popleft()
        d = found[rid]["depth"]
        if max_depth is not None and d >= max_depth:
            continue
        for e, other, way in idx.steps(rid, direction, ks):
            if other in found or (tables is not None and idx.recs[other][0].name not in tables):
                continue
            if len(found) >= limit:
                truncated = True
                break
            found[other] = {**idx.node(other), "depth": d + 1, "via": {"from": rid, "dir": way, **e.to_dict()}}
            queue.append(other)
    keep = set(found)
    if where is not None:
        keep &= matching(conn, idx, keep, where)
    changed = _changed_since(conn, domain, set(found), since) if since is not None else {}
    if since is not None:
        keep &= set(changed)
    keep |= set(seeds) & set(found)
    want = _fields(fields)
    nodes = []
    for rid, n in found.items():
        if rid not in keep:
            continue
        if since is not None:
            n["changed"] = changed.get(rid)
        if want is not False:
            n["data"] = _data(idx, rid, want)
        nodes.append(n)
    return {
        "seq": _seq(conn),
        "seeds": [rid for rid in seeds if rid in found],
        "nodes": nodes,
        "edges": idx.edges_among(keep, ks),
        "touches": _touches(conn, domain, list(idx.by_name), keep),
        "truncated": truncated,
    }


def path(conn, domain_id: int, source: int, target: int, direction: str = "both", kinds: str | None = None) -> dict:
    """两条记录之间最短的关联路径；edges 按路径顺序排列，dir 表示沿边方向（out）还是逆着走（in）。"""
    _check_direction(direction)
    ks = parse_kinds(kinds)
    idx = Index(conn, domain_id)
    idx.require(source)
    idx.require(target)
    prev: dict[int, tuple | None] = {source: None}
    queue = deque([source])
    while queue and target not in prev:
        rid = queue.popleft()
        for e, other, way in idx.steps(rid, direction, ks):
            if other not in prev:
                prev[other] = (rid, e, way)
                queue.append(other)
    if target not in prev:
        return {"found": False, "nodes": [], "edges": []}
    chain, edges, rid = [target], [], target
    while prev[rid] is not None:
        rid, e, way = prev[rid]
        chain.append(rid)
        edges.append({**e.to_dict(), "dir": way})
    return {"found": True, "nodes": [idx.node(r) for r in reversed(chain)], "edges": edges[::-1]}


def lint(conn, domain_id: int, tables: list[str] | None = None, limit: int = 200) -> dict:
    """悬空引用（link 指向的记录不存在）和孤立记录（没有父子也没有引用关系）。"""
    idx = Index(conn, domain_id)
    if tables is not None:
        missing = set(tables) - set(idx.by_name)
        if missing:
            raise not_found(f"表 {'、'.join(sorted(missing))}", "用 dt table list 查看当前域里的表")
    keep = (lambda name: True) if tables is None else (lambda name: name in tables)
    dangling = [d for d in idx.dangling if keep(d["table"])]
    orphans = [idx.brief(rid) for rid, (t, _, _) in idx.recs.items() if keep(t.name) and not idx.out[rid] and not idx.inn[rid]]
    # 自引用的 link 字段（如 task.needs → task）通常表示依赖，成环时依赖永远满足不了
    cycles = [
        {"field": f"{t.name}.{f.key}", "records": [idx.brief(rid) for rid in ring]}
        for t in idx.tables if keep(t.name)
        for f in t.active_fields if f.type == "link" and f.config["table"] == t.name
        for ring in _cycles(_deps(idx, t, f.key))
    ]
    return {
        "dangling": {"total": len(dangling), "items": dangling[:limit]},
        "orphans": {"total": len(orphans), "items": orphans[:limit]},
        "cycles": {"total": len(cycles), "items": cycles[:limit]},
    }


# ---------- 依赖：把一个 link 字段看成「持有方依赖被引用方」 ----------

def dep_field(idx: Index, spec: str | None) -> tuple[Table, str]:
    """spec 写成 <表>.<字段>，必须是 link 字段。"""
    links = [f"{t.name}.{f.key}" for t in idx.tables for f in t.active_fields if f.type == "link"]
    hint = "可用的 link 字段：" + ("、".join(links) if links else "（这个域里还没有 link 字段）")
    name, _, key = (spec or "").partition(".")
    table = idx.by_name.get(name)
    f = table.field(key) if table else None
    if f is None or f.type != "link":
        raise DtError("invalid_query", f"{spec!r} 不是 link 字段", hint)
    return table, key


def _deps(idx: Index, table: Table, key: str) -> dict[int, list[int]]:
    """table 里每条记录 → 它的 key 字段指向的记录（只算存在的）。"""
    return {
        rid: [e.target for e in idx.out[rid] if e.kind == "link" and e.field == key and e.owner == table.name]
        for rid, (t, _, _) in idx.recs.items() if t.name == table.name
    }


def _cycles(deps: dict[int, list[int]]) -> list[list[int]]:
    """Tarjan 强连通分量：多于一条记录的分量，或者自己依赖自己，就是一个环。迭代实现，不怕依赖链太长。"""
    index, low, on, stack, out, counter = {}, {}, set(), [], [], [0]
    for root in deps:
        if root in index:
            continue
        work = [(root, iter(deps.get(root, ())))]
        index[root] = low[root] = counter[0]
        counter[0] += 1
        stack.append(root)
        on.add(root)
        while work:
            v, it = work[-1]
            w = next(it, None)
            if w is not None:
                if w not in index:
                    index[w] = low[w] = counter[0]
                    counter[0] += 1
                    stack.append(w)
                    on.add(w)
                    work.append((w, iter(deps.get(w, ()))))
                elif w in on:
                    low[v] = min(low[v], index[w])
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                ring = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    ring.append(w)
                    if w == v:
                        break
                if len(ring) > 1 or v in deps.get(v, ()):
                    out.append(sorted(ring))
    return sorted(out)


def _closure(deps: dict[int, list[int]], roots: list[int]) -> set:
    """roots 和它们直接、间接依赖的全部记录。"""
    seen, stack = set(roots), list(roots)
    while stack:
        for d in deps.get(stack.pop(), ()):
            if d not in seen:
                seen.add(d)
                stack.append(d)
    return seen


def ready(conn, domain_id: int, field: str, done: dict, where: dict | None = None, limit: int = 200, fields: str | None = None) -> dict:
    """依赖都已完成、自己还没完成的记录（ready），以及还在等依赖的记录（blocked，带 waiting）。
    done 是「已完成」的条件；where 只筛选候选记录。悬空的依赖不算阻塞，用 lint 检查。"""
    idx = Index(conn, domain_id)
    table, key = dep_field(idx, field)
    deps = _deps(idx, table, key)
    involved = set(deps) | {d for ds in deps.values() for d in ds}
    finished = matching(conn, idx, involved, done, "done")
    todo = [rid for rid in deps if rid not in finished]
    if where is not None:
        hit = matching(conn, idx, todo, where)
        todo = [rid for rid in todo if rid in hit]
    want = _fields(fields)
    in_cycle = {rid for ring in _cycles(deps) for rid in ring}

    def item(rid: int, **extra) -> dict:
        return {**idx.node(rid), **extra, **({} if want is False else {"data": _data(idx, rid, want)})}

    ok_, blocked = [], []
    for rid in todo:
        waiting = [d for d in deps[rid] if d not in finished]
        if waiting:
            blocked.append(item(rid, waiting=[idx.brief(d) for d in waiting], in_cycle=rid in in_cycle))
        else:
            ok_.append(item(rid, needs=len(deps[rid])))
    return {
        "field": field,
        "done": len([rid for rid in deps if rid in finished]),
        "ready": {"total": len(ok_), "items": ok_[:limit]},
        "blocked": {"total": len(blocked), "items": blocked[:limit]},
    }


def order(conn, domain_id: int, field: str, ids: list[int] | None = None, done: dict | None = None) -> dict:
    """按依赖排的拓扑序：被依赖的在前。level 是最长依赖链的层数，同一层之间没有依赖、可以并行。
    ids 给出时只排这些记录和它们（间接）依赖的记录；done 给出时已完成的记录不参与排序，也不再算作依赖。
    成环的记录排不出先后，放在 cycles 里。"""
    idx = Index(conn, domain_id)
    table, key = dep_field(idx, field)
    deps = _deps(idx, table, key)
    for rid in ids or []:
        idx.require(rid)
        if rid not in deps:
            raise DtError("invalid_query", f"记录 {rid} 不在表 {table.name} 里", f"{field} 只能排 {table.name} 的记录")
    scope = _closure(deps, ids) if ids else set(deps) | {d for ds in deps.values() for d in ds}
    if done is not None:
        scope -= matching(conn, idx, scope, done, "done")
    need = {rid: [d for d in deps.get(rid, ()) if d in scope] for rid in scope}
    level: dict[int, int] = {}
    pending = {rid: len(ds) for rid, ds in need.items()}
    users = defaultdict(list)
    for rid, ds in need.items():
        for d in ds:
            users[d].append(rid)
    queue = deque(sorted(rid for rid, n in pending.items() if n == 0))
    for rid in queue:
        level[rid] = 0
    out = []
    while queue:
        rid = queue.popleft()
        out.append({**idx.node(rid), "level": level[rid], "needs": need[rid]})
        for u in sorted(users[rid]):
            level[u] = max(level.get(u, 0), level[rid] + 1)
            pending[u] -= 1
            if pending[u] == 0:
                queue.append(u)
    rings = _cycles({rid: need[rid] for rid in scope})
    placed = {n["id"] for n in out}
    stuck = sorted(rid for rid in scope if rid not in placed)
    return {
        "field": field,
        "complete": not stuck,
        "order": out,
        "cycles": [[idx.brief(rid) for rid in ring] for ring in rings],
        "stuck": [idx.brief(rid) for rid in stuck],
    }


def hubs(conn, domain_id: int, tables: list[str] | None = None, kinds: str | None = None, limit: int = 20) -> dict:
    """连接最多的记录：degree = in + out，in 是指向它的边（被引用、它的父记录），out 是它发出的边。"""
    ks = parse_kinds(kinds)
    idx = Index(conn, domain_id)
    if tables is not None:
        missing = set(tables) - set(idx.by_name)
        if missing:
            raise not_found(f"表 {'、'.join(sorted(missing))}", "用 dt table list 查看当前域里的表")
    items = []
    for rid, (t, _, _) in idx.recs.items():
        if tables is not None and t.name not in tables:
            continue
        n_in = sum(1 for e in idx.inn[rid] if _passes(e, ks))
        n_out = sum(1 for e in idx.out[rid] if _passes(e, ks))
        if n_in + n_out:
            items.append({**idx.brief(rid), "degree": n_in + n_out, "in": n_in, "out": n_out})
    items.sort(key=lambda x: (-x["degree"], -x["in"], x["id"]))
    return {"total": len(items), "items": items[:limit]}


# ---------- 导出成 Mermaid / Graphviz dot ----------

FORMATS = ("mermaid", "dot")


def check_format(fmt: str | None):
    if fmt is not None and fmt not in FORMATS:
        raise DtError("invalid_query", f"不支持导出格式 {fmt!r}", "可用：mermaid、dot")


def _label(table: Table | None, name: str) -> str:
    return (table.label if table and table.label else name)


def _field_label(table: Table | None, key: str) -> str:
    f = table.field(key) if table else None
    return f.label if f and f.label else key


def render(fmt: str, conn, domain_id: int, nodes: list[dict], edges: list[dict]) -> str:
    """把接口返回的 nodes / edges 画成文本。节点按表分组，父子边实线，link 边虚线并标字段名。"""
    by_name = {t.name: t for t in list_tables(conn, domain_id)}
    table_of = {n["id"]: n["table"] for n in nodes}
    groups: dict[str, list[dict]] = defaultdict(list)
    for n in nodes:
        groups[n["table"]].append(n)

    def edge_label(e: dict) -> str:
        return "" if e["kind"] == "parent" else _field_label(by_name.get(table_of.get(e["source"], "")), e["field"])

    if fmt == "mermaid":
        def q(s: str) -> str:
            return '"' + s.replace('"', "#quot;").replace("\n", " ") + '"'

        lines = ["flowchart LR"]
        for name, ns in groups.items():
            lines.append(f"  subgraph {name}[{q(_label(by_name.get(name), name))}]")
            lines += [f"    r{n['id']}[{q(n['title'] + ' #' + str(n['id']))}]" for n in ns]
            lines.append("  end")
        for e in edges:
            label = edge_label(e)
            arrow = f"-.->|{q(label)}|" if label else "-->"
            lines.append(f"  r{e['source']} {arrow} r{e['target']}")
        return "\n".join(lines) + "\n"

    def d(s: str) -> str:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'

    lines = ["digraph dt {", "  rankdir=LR;", "  node [shape=box, style=rounded];"]
    for name, ns in groups.items():
        lines.append(f"  subgraph cluster_{name} {{")
        lines.append(f"    label={d(_label(by_name.get(name), name))};")
        lines += [f"    r{n['id']} [label={d(n['title'] + ' #' + str(n['id']))}];" for n in ns]
        lines.append("  }")
    for e in edges:
        label = edge_label(e)
        lines.append(f"  r{e['source']} -> r{e['target']}" + (f" [label={d(label)}, style=dashed];" if label else ";"))
    lines.append("}")
    return "\n".join(lines) + "\n"


def impact(conn, table: Table, record_id: int) -> dict:
    """删除一条记录会发生什么：cascade 一起删的子记录，unlink 会被去掉引用的记录，blocked 有 restrict 子表挡住时非空。"""
    idx = Index(conn, table.domain_id)
    if record_id not in idx.recs or idx.recs[record_id][0].name != table.name:
        raise not_found(f"{table.name} 记录 {record_id}", f"用 dt rec query {table.name} 查找记录 id")
    doomed, stack = [], [record_id]
    while stack:
        rid = stack.pop()
        doomed.append(rid)
        stack += [e.target for e in idx.out[rid] if e.kind == "parent"]
    gone = set(doomed)
    blocked = []
    for rid in doomed:
        kids = Counter(idx.recs[e.target][0].name for e in idx.out[rid] if e.kind == "parent")
        for name, n in kids.items():
            if idx.by_name[name].on_delete == "restrict":
                blocked.append({**idx.brief(rid), "child": name, "count": n})
    unlink = [
        {**idx.brief(e.source), "field": e.field, "target": rid}
        for rid in doomed for e in idx.inn[rid] if e.kind == "link" and e.source not in gone
    ]
    return {
        "record": idx.brief(record_id),
        "cascade": [idx.brief(rid) for rid in doomed[1:]],
        "unlink": unlink,
        "blocked": blocked,
    }
