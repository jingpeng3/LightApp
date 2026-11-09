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
