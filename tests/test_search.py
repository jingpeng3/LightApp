import pytest


@pytest.fixture
def data(task_api):
    rows = [
        {"title": "写设计文档", "status": "进行中", "tags": ["设计"], "points": 3, "done": True},
        {"title": "实现 CLI", "status": "待办", "tags": ["后端"], "points": 5},
        {"title": "做页面", "status": "完成", "tags": ["前端", "设计"], "points": 8, "done": True},
        {"title": "压测", "tags": []},
    ]
    task_api("POST", "/tables/task/records", {"rows": rows}, actor="claude")
    return task_api


def test_facets(data):
    r = data("POST", "/tables/task/facets", {})
    assert r["total"] == 4
    assert set(r["fields"]) == {"status", "tags", "done"}
    assert r["fields"]["status"] == {"values": [{"value": "待办", "count": 2}, {"value": "完成", "count": 1}, {"value": "进行中", "count": 1}], "empty": 0}
    assert r["fields"]["tags"]["values"][0] == {"value": "设计", "count": 2}
    assert r["fields"]["tags"]["empty"] == 1  # 空数组按空值存
    assert r["fields"]["done"]["values"] == [{"value": False, "count": 2}, {"value": True, "count": 2}]
    r = data("POST", "/tables/task/facets", {"fields": ["status", "_created_by"], "where": {"tags": {"in": ["设计"]}}})
    assert r["total"] == 2 and r["fields"]["_created_by"]["values"] == [{"value": "claude", "count": 2}]
    assert data.err("POST", "/tables/task/facets", {"fields": ["title"]})["code"] == "invalid_query"


def test_search_domain(data):
    t = data.query("task", where={"title": "压测"})[0]
    data.insert("task_log", {"content": "压测跑完，p99 4ms"}, t["_id"])
    r = data("GET", "/d/w/search", q="压测")
    assert [(g["table"], g["total"]) for g in r["groups"]] == [("task", 1), ("task_log", 1)]
    log = r["groups"][1]["items"][0]
    assert log["parent_id"] == t["_id"] and log["title"].startswith("压测跑完")
    assert [g["table"] for g in data("GET", "/d/w/search", q="压测", tables="task_log")["groups"]] == ["task_log"]
    assert data("GET", "/d/w/search", q="不存在的词")["groups"] == []
    assert data.err("GET", "/d/w/search", q=" ")["code"] == "invalid_query"


def test_views(data):
    v = data("POST", "/d/w/views", {"table": "task", "name": "没完成", "where": {"status": {"ne": "完成"}}, "sort": "-points"})
    assert v["name"] == "没完成" and v["created_by"] == "tester"
    titles = lambda **body: [r["title"] for r in data("POST", "/tables/task/query", body)["items"]]
    assert titles(view="没完成") == ["实现 CLI", "写设计文档", "压测"]
    assert titles(view="没完成", where={"tags": {"in": ["设计"]}}) == ["写设计文档"]  # 叠加条件
    assert titles(view="没完成", sort="_id") == ["写设计文档", "实现 CLI", "压测"]  # 覆盖排序
    assert data("POST", "/tables/task/facets", {"view": "没完成", "fields": ["status"]})["total"] == 3

    # 同名保存是覆盖
    data("POST", "/d/w/views", {"table": "task", "name": "没完成", "where": {"status": "待办"}})
    assert [x["where"] for x in data("GET", "/d/w/views")] == [{"status": "待办"}]
    data("PATCH", f"/d/w/views/{v['id']}", {"name": "待办"})
    assert data("GET", "/d/w/views", table="task")[0]["name"] == "待办"
    assert data("GET", "/changes")[-1]["op"] == "alter_view"

    assert data.err("POST", "/d/w/views", {"table": "task", "name": "x", "where": {"nope": 1}})["code"] == "invalid_query"
    assert data.err("POST", "/tables/task/query", {"view": "没完成"})["code"] == "not_found"
    data("DELETE", f"/d/w/views/{v['id']}")
    assert data("GET", "/d/w/views") == []


def test_views_follow_table(data):
    data("POST", "/d/w/views", {"table": "task_log", "name": "警告", "where": {"level": "warn"}})
    data("DELETE", "/tables/task", force=True)
    assert data("GET", "/d/w/views") == []
