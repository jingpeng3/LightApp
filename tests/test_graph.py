import time

AGENT = {"name": "agent", "fields": [{"key": "name", "type": "text", "required": True}]}
JOB = {
    "name": "job",
    "fields": [{"key": "title", "type": "text"}],
    "children": [{
        "name": "task",
        "fields": [
            {"key": "title", "type": "text"},
            {"key": "agent", "type": "link", "config": {"table": "agent"}},
            {"key": "needs", "type": "link", "config": {"table": "task", "multiple": True}},
        ],
    }],
}


def graph(api, **params):
    return api("GET", f"/d/{api.domain}/graph", **params)


def edges(g):
    return {(e["source"], e["target"], e["kind"], e.get("field")) for e in g["edges"]}


def setup(api):
    api.apply(AGENT)
    api.apply(JOB)
    a = api.insert("agent", {"name": "claude"})["_id"]
    job = api.insert("job", {})["_id"]
    t1 = api.insert("task", {"title": "设计", "agent": a}, parent_id=job)["_id"]
    t2 = api.insert("task", {"title": "实现", "agent": a, "needs": [t1]}, parent_id=job)["_id"]
    return a, job, t1, t2


def test_nodes_and_edges(api):
    a, job, t1, t2 = setup(api)
    g = graph(api)
    titles = {n["id"]: n["title"] for n in g["nodes"]}
    assert titles == {a: "claude", job: f"#{job}", t1: "设计", t2: "实现"}
    assert g["total"] == 4 and not g["truncated"] and g["seq"] > 0
    assert edges(g) == {
        (job, t1, "parent", None), (job, t2, "parent", None),
        (t1, a, "link", "agent"), (t2, a, "link", "agent"), (t2, t1, "link", "needs"),
    }
    te = {(e["source"], e["target"], e["kind"], e.get("field")): e["count"] for e in g["table_edges"]}
    assert te == {("job", "task", "parent", None): 2, ("task", "agent", "link", "agent"): 2, ("task", "task", "link", "needs"): 1}


def test_table_scope_drops_outside_edges(api):
    a, job, t1, t2 = setup(api)
    g = graph(api, tables="task,agent")
    assert {n["id"] for n in g["nodes"]} == {a, t1, t2}
    assert edges(g) == {(t1, a, "link", "agent"), (t2, a, "link", "agent"), (t2, t1, "link", "needs")}
    assert len(g["table_edges"]) == 3
    assert graph(api, tables="")["nodes"] == []
    assert api.err("GET", f"/d/{api.domain}/graph", tables="task,nope")["code"] == "not_found"


def test_touches_count_actor_writes(api):
    a, job, t1, t2 = setup(api)
    api("PATCH", f"/tables/task/records/{t1}", {"set": {"title": "设计 v2"}}, actor="codex")
    api("PATCH", f"/tables/task/records/{t1}", {"set": {"title": "设计 v3"}}, actor="codex")
    touches = {(t["actor"], t["record_id"]): t["count"] for t in graph(api)["touches"]}
    assert touches[("tester", t1)] == 1 and touches[("codex", t1)] == 2 and ("codex", t2) not in touches
    assert ("codex", t1) not in {(t["actor"], t["record_id"]) for t in graph(api, tables="agent")["touches"]}


def test_limit_keeps_recent(api):
    a, job, t1, t2 = setup(api)
    time.sleep(0.01)
    api("PATCH", f"/tables/agent/records/{a}", {"set": {"name": "claude-2"}})
    g = graph(api, limit=2)
    assert g["truncated"] and g["nodes"][0]["id"] == a and len(g["nodes"]) == 2
    assert all(e["source"] in {n["id"] for n in g["nodes"]} for e in g["edges"])
    empty = graph(api, limit=0)
    assert empty["nodes"] == [] and empty["total"] == 4 and len(empty["table_edges"]) == 3


def test_delete_removes_node_and_links(api):
    a, job, t1, t2 = setup(api)
    api("DELETE", f"/tables/task/records/{t1}")
    g = graph(api)
    assert t1 not in {n["id"] for n in g["nodes"]}
    assert edges(g) == {(job, t2, "parent", None), (t2, a, "link", "agent")}
    assert all(t["record_id"] != t1 for t in g["touches"])


def related(api, by=None, **params):
    """by 是按操作者查的 actor 参数；api() 的 actor 关键字被用作请求头，所以放进查询串。"""
    if by:
        params["actor"] = by
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return api("GET", f"/d/{api.domain}/graph/related?{q}")


def ids_by_depth(r):
    return {n["id"]: n["depth"] for n in r["nodes"]}


def chain(api):
    """t1 ← t2 ← t3（needs），都派给 agent a；另有一条孤立的 agent b。"""
    a, job, t1, t2 = setup(api)
    t3 = api.insert("task", {"title": "测试", "needs": [t2]}, parent_id=job)["_id"]
    b = api.insert("agent", {"name": "idle"})["_id"]
    return a, b, job, t1, t2, t3


def test_related_depth_and_via(api):
    a, b, job, t1, t2, t3 = chain(api)
    r = related(api, ids=t1)
    assert ids_by_depth(r) == {t1: 0, job: 1, a: 1, t2: 1}
    via = {n["id"]: n["via"] for n in r["nodes"]}
    assert via[t1] is None and via[a] == {"from": t1, "dir": "out", "source": t1, "target": a, "kind": "link", "field": "agent"}
    assert via[t2]["dir"] == "in" and via[job]["kind"] == "parent"
    assert (t2, t1, "link", "needs") in edges(r) and not r["truncated"] and r["seeds"] == [t1]
    assert set(ids_by_depth(related(api, ids=t1, depth="all"))) == {a, job, t1, t2, t3}
    assert ids_by_depth(related(api, ids=t1, depth=0)) == {t1: 0}


def test_related_direction_kinds_tables(api):
    a, b, job, t1, t2, t3 = chain(api)
    assert ids_by_depth(related(api, ids=t3, direction="out", kinds="link:task.needs", depth="all")) == {t3: 0, t2: 1, t1: 2}
    assert ids_by_depth(related(api, ids=t1, direction="in", kinds="link", depth="all")) == {t1: 0, t2: 1, t3: 2}
    assert set(ids_by_depth(related(api, ids=job, direction="out", kinds="parent"))) == {job, t1, t2, t3}
    # 只经过 task 表：到不了 agent 和 job
    assert set(ids_by_depth(related(api, ids=t1, depth="all", tables="task"))) == {t1, t2, t3}
    assert ids_by_depth(related(api, ids=b, depth="all")) == {b: 0}


def test_related_limit_and_errors(api):
    a, b, job, t1, t2, t3 = chain(api)
    r = related(api, ids=t1, depth="all", limit=2)
    assert r["truncated"] and len(r["nodes"]) == 2
    path_ = f"/d/{api.domain}/graph/related"
    assert api.err("GET", path_)["code"] == "invalid_query"
    assert api.err("GET", path_, ids=999999)["code"] == "not_found"
    assert api.err("GET", path_, ids=t1, direction="up")["code"] == "invalid_query"
    assert api.err("GET", path_, ids=t1, kinds="actor")["code"] == "invalid_query"
    assert api.err("GET", path_, ids=t1, depth="x")["code"] == "invalid_query"
    assert api.err("GET", path_, ids=t1, tables="nope")["code"] == "not_found"


def test_related_by_actor(api):
    a, b, job, t1, t2, t3 = chain(api)
    api("PATCH", f"/tables/task/records/{t3}", {"set": {"title": "测试 v2"}}, actor="codex")
    r = related(api, by="codex", depth=0)
    assert r["seeds"] == [t3] and ids_by_depth(r) == {t3: 0}
    assert set(ids_by_depth(related(api, by="codex"))) == {t3, t2, job}
    assert related(api, by="nobody")["nodes"] == []


def test_path(api):
    a, b, job, t1, t2, t3 = chain(api)
    p = api("GET", f"/d/{api.domain}/graph/path", source=t3, target=a, kinds="link")
    assert p["found"] and [n["id"] for n in p["nodes"]] == [t3, t2, a]
    assert p["edges"] == [
        {"source": t3, "target": t2, "kind": "link", "field": "needs", "dir": "out"},
        {"source": t2, "target": a, "kind": "link", "field": "agent", "dir": "out"},
    ]
    back = api("GET", f"/d/{api.domain}/graph/path", source=a, target=t3, direction="out")
    assert not back["found"] and back["nodes"] == []
    assert not api("GET", f"/d/{api.domain}/graph/path", source=t1, target=b)["found"]
    same = api("GET", f"/d/{api.domain}/graph/path", source=t1, target=t1)
    assert same["found"] and [n["id"] for n in same["nodes"]] == [t1] and same["edges"] == []


def test_lint_orphans_and_dangling(api):
    a, b, job, t1, t2, t3 = chain(api)
    lint = api("GET", f"/d/{api.domain}/graph/lint")
    assert [o["id"] for o in lint["orphans"]["items"]] == [b] and lint["dangling"]["total"] == 0
    # 绕过接口写一个指向不存在记录的 link，模拟老数据
    api.db.conn.execute("UPDATE dt_records SET data = json_set(data, '$.agent', 999999) WHERE id = ?", (t3,))
    d = api("GET", f"/d/{api.domain}/graph/lint")["dangling"]
    assert d["items"] == [{"table": "task", "id": t3, "title": "测试", "field": "agent", "target": 999999, "target_table": "agent"}]
    assert api("GET", f"/d/{api.domain}/graph/lint", tables="agent")["dangling"]["total"] == 0


def test_delete_impact_matches_delete(api):
    a, b, job, t1, t2, t3 = chain(api)
    imp = api("GET", f"/tables/task/records/{t2}/impact")
    assert imp["record"]["id"] == t2 and imp["cascade"] == [] and imp["blocked"] == []
    assert imp["unlink"] == [{"table": "task", "id": t3, "title": "测试", "field": "needs", "target": t2}]
    job_imp = api("GET", f"/tables/job/records/{job}/impact")
    assert {c["id"] for c in job_imp["cascade"]} == {t1, t2, t3} and job_imp["unlink"] == []
    assert api.err("GET", f"/tables/job/records/{t1}/impact")["code"] == "not_found"

    res = api("DELETE", f"/tables/task/records/{t2}")
    assert res["unlinked"] == [{"table": "task", "_id": t3, "field": "needs", "target": t2}]
    assert api("DELETE", f"/tables/job/records/{job}")["unlinked"] == []


def test_delete_impact_restrict(api):
    api.apply({"name": "proj", "fields": [{"key": "name", "type": "text"}],
               "children": [{"name": "step", "on_delete": "restrict", "fields": [{"key": "name", "type": "text"}]}]})
    p = api.insert("proj", {"name": "p", "step": [{"name": "s1"}, {"name": "s2"}]})["_id"]
    imp = api("GET", f"/tables/proj/records/{p}/impact")
    assert imp["blocked"] == [{"table": "proj", "id": p, "title": "p", "child": "step", "count": 2}]


# ---------- related 带数据、where、since ----------

FLOW = {
    "name": "step",
    "fields": [
        {"key": "title", "type": "text"},
        {"key": "status", "type": "single_select", "options": ["待办", "完成"], "default": "待办"},
        {"key": "needs", "type": "link", "config": {"table": "step", "multiple": True}},
    ],
}


def flow(api):
    """s1 ← s2 ← s4，s1 ← s3 ← s4（needs），s1 已完成；s5 和 s6 互相依赖成环。"""
    api.apply(FLOW)
    s1 = api.insert("step", {"title": "设计", "status": "完成"})["_id"]
    s2 = api.insert("step", {"title": "后端", "needs": [s1]})["_id"]
    s3 = api.insert("step", {"title": "前端", "needs": [s1]})["_id"]
    s4 = api.insert("step", {"title": "联调", "needs": [s2, s3]})["_id"]
    s5 = api.insert("step", {"title": "甲"})["_id"]
    s6 = api.insert("step", {"title": "乙", "needs": [s5]})["_id"]
    api("PATCH", f"/tables/step/records/{s5}", {"set": {"needs": [s6]}})
    return s1, s2, s3, s4, s5, s6


def test_related_fields_and_where(api):
    a, b, job, t1, t2, t3 = chain(api)
    r = related(api, ids=t1, depth="all", fields="*")
    data = {n["id"]: n["data"] for n in r["nodes"]}
    assert data[t2]["title"] == "实现" and data[t2]["needs"] == [t1] and data[t2]["_parent_id"] == job
    assert all("data" not in n for n in related(api, ids=t1)["nodes"])
    slim = related(api, ids=t1, fields="title,_version,nope")["nodes"][0]["data"]
    assert slim == {"title": "设计", "_version": 1}
    # where 只筛结果，不挡遍历：t3 经 t2 到达，t2 本身被筛掉
    w = related(api, ids=t1, depth="all", where='{"title":{"contains":"测"}}')
    assert set(ids_by_depth(w)) == {t1, t3} and w["edges"] == []
    # 用到的字段只有部分表有：其他表的记录算不满足
    assert set(ids_by_depth(related(api, ids=t1, depth="all", where='{"name":"claude"}'))) == {t1, a}
    path_ = f"/d/{api.domain}/graph/related"
    assert api.err("GET", path_, ids=t1, where='{"nope":1}')["code"] == "invalid_query"
    assert api.err("GET", path_, ids=t1, where="{bad")["code"] == "invalid_json"


def test_related_since(api):
    a, b, job, t1, t2, t3 = chain(api)
    seq = graph(api)["seq"]
    api("PATCH", f"/tables/task/records/{t2}", {"set": {"title": "实现 v2"}}, actor="codex")
    t4 = api.insert("task", {"title": "上线", "needs": [t3]}, parent_id=job)["_id"]
    r = related(api, ids=t1, depth="all", since=seq)
    assert set(ids_by_depth(r)) == {t1, t2, t4}
    changed = {n["id"]: n["changed"] for n in r["nodes"]}
    assert changed[t1] is None
    assert changed[t2]["count"] == 1 and changed[t2]["actors"] == ["codex"] and changed[t2]["fields"] == ["title"]
    assert changed[t4]["ops"] == ["insert"] and changed[t4]["last_seq"] > seq


def test_export_formats(api):
    a, b, job, t1, t2, t3 = chain(api)
    m = api("GET", f"/d/{api.domain}/graph/related", ids=t2, format="mermaid")
    assert m["format"] == "mermaid" and m["text"].startswith("flowchart LR")
    assert f'r{t2} -.->|"needs"| r{t1}' in m["text"] and f"r{job} --> r{t2}" in m["text"]
    assert f'r{t2}["实现 #{t2}"]' in m["text"]
    d = api("GET", f"/d/{api.domain}/graph/path", source=t3, target=a, kinds="link", format="dot")["text"]
    assert d.startswith("digraph dt {") and f'r{t3} -> r{t2} [label="needs", style=dashed];' in d
    assert "cluster_task" in d
    assert api.err("GET", f"/d/{api.domain}/graph/related", ids=t2, format="png")["code"] == "invalid_query"


# ---------- 依赖：ready、order、环 ----------

def ready(api, **params):
    return api("GET", f"/d/{api.domain}/graph/ready", field="step.needs", done='{"status":"完成"}', **params)


def test_ready_and_blocked(api):
    s1, s2, s3, s4, s5, s6 = flow(api)
    r = ready(api)
    assert [n["id"] for n in r["ready"]["items"]] == [s2, s3] and r["done"] == 1
    blocked = {n["id"]: n for n in r["blocked"]["items"]}
    assert [w["id"] for w in blocked[s4]["waiting"]] == [s2, s3] and not blocked[s4]["in_cycle"]
    assert blocked[s5]["in_cycle"] and blocked[s6]["in_cycle"]
    api("PATCH", f"/tables/step/records/{s2}", {"set": {"status": "完成"}})
    api("PATCH", f"/tables/step/records/{s3}", {"set": {"status": "完成"}})
    r = ready(api, where='{"title":"联调"}', fields="title")
    assert [n["id"] for n in r["ready"]["items"]] == [s4] and r["ready"]["items"][0]["data"] == {"title": "联调"}
    assert r["blocked"]["total"] == 0
    e = api.err("GET", f"/d/{api.domain}/graph/ready", field="step.title", done='{"status":"完成"}')
    assert e["code"] == "invalid_query" and "step.needs" in e["hint"]
    assert api.err("GET", f"/d/{api.domain}/graph/ready", field="step.needs", done='{"nope":1}')["code"] == "invalid_query"


def test_order_and_cycles(api):
    s1, s2, s3, s4, s5, s6 = flow(api)
    o = api("GET", f"/d/{api.domain}/graph/order", field="step.needs")
    levels = {n["id"]: n["level"] for n in o["order"]}
    assert levels == {s1: 0, s2: 1, s3: 1, s4: 2}
    assert [n["id"] for n in o["order"]][:1] == [s1] and not o["complete"]
    assert [[x["id"] for x in ring] for ring in o["cycles"]] == [[s5, s6]]
    assert [x["id"] for x in o["stuck"]] == [s5, s6]
    sub = api("GET", f"/d/{api.domain}/graph/order", field="step.needs", ids=s4, done='{"status":"完成"}')
    assert {n["id"]: n["level"] for n in sub["order"]} == {s2: 0, s3: 0, s4: 1} and sub["complete"]
    lint = api("GET", f"/d/{api.domain}/graph/lint")
    assert lint["cycles"]["items"] == [{"field": "step.needs", "records": [
        {"table": "step", "id": s5, "title": "甲"}, {"table": "step", "id": s6, "title": "乙"}]}]


def test_self_dependency_is_cycle(api):
    api.apply(FLOW)
    s = api.insert("step", {"title": "自己"})["_id"]
    api("PATCH", f"/tables/step/records/{s}", {"set": {"needs": [s]}})
    assert api("GET", f"/d/{api.domain}/graph/lint")["cycles"]["total"] == 1


# ---------- 枢纽、孤立数、历史回放 ----------

def test_hubs_and_orphan_counts(api):
    a, b, job, t1, t2, t3 = chain(api)
    h = api("GET", f"/d/{api.domain}/graph/hubs", limit=2)
    assert [x["id"] for x in h["items"]] == [t2, t1] and h["items"][0] == {
        "table": "task", "id": t2, "title": "实现", "degree": 4, "in": 2, "out": 2}
    assert h["total"] == 5
    assert {x["id"]: x["degree"] for x in api("GET", f"/d/{api.domain}/graph/hubs", kinds="link")["items"]} == {t2: 3, a: 2, t1: 2, t3: 1}
    assert graph(api, limit=0)["orphans"] == {"agent": 1}


def test_graph_at_seq(api):
    a, job, t1, t2 = setup(api)
    mid = graph(api)["seq"]
    api("PATCH", f"/tables/task/records/{t2}", {"set": {"needs": [], "title": "实现 v2"}}, actor="codex")
    api("DELETE", f"/tables/task/records/{t1}")
    then = graph(api, at=mid)
    assert then["seq"] == mid and {n["id"] for n in then["nodes"]} == {a, job, t1, t2}
    assert (t2, t1, "link", "needs") in edges(then)
    assert {n["id"]: n["title"] for n in then["nodes"]}[t2] == "实现"
    assert ("codex", t2) not in {(t["actor"], t["record_id"]) for t in then["touches"]}
    tl = then["timeline"]
    assert tl["first_seq"] > 0 and tl["last_seq"] > mid and tl["at_ts"]
    assert edges(graph(api, at=tl["first_seq"])) == set() and len(graph(api, at=tl["first_seq"])["nodes"]) == 1
    now = graph(api, at=tl["last_seq"])
    assert {n["id"] for n in now["nodes"]} == {n["id"] for n in graph(api)["nodes"]}
