import pytest


@pytest.fixture
def data(task_api):
    rows = [
        {"title": "写设计文档", "status": "进行中", "tags": ["设计"], "due": "2026-11-08", "points": 3, "done": False},
        {"title": "实现 CLI", "status": "待办", "tags": ["后端"], "due": "2026-11-12", "points": 5},
        {"title": "做页面", "status": "完成", "tags": ["前端", "设计"], "points": 8, "done": True},
    ]
    task_api("POST", "/tables/task/records", {"rows": rows}, actor="claude")
    return task_api


def titles(api, **body):
    return [r["title"] for r in api.query("task", **body)]


def test_operators(data):
    assert titles(data, where={"status": "待办"}) == ["实现 CLI"]
    assert titles(data, where={"status": {"in": ["待办", "进行中"]}}) == ["写设计文档", "实现 CLI"]
    assert titles(data, where={"status": {"nin": ["完成"]}}) == ["写设计文档", "实现 CLI"]
    assert titles(data, where={"due": {"lt": "2026-11-10"}}) == ["写设计文档"]
    assert titles(data, where={"due": {"is_null": True}}) == ["做页面"]
    assert titles(data, where={"points": {"gte": "5"}}) == ["实现 CLI", "做页面"]
    assert titles(data, where={"title": {"contains": "cli"}}) == ["实现 CLI"]
    assert titles(data, where={"done": False}) == ["写设计文档", "实现 CLI"]
    assert titles(data, where={"status": {"ne": "完成"}, "points": {"gt": 3}}) == ["实现 CLI"]


def test_array_fields(data):
    assert titles(data, where={"tags": {"contains": "设计"}}) == ["写设计文档", "做页面"]
    assert titles(data, where={"tags": ["前端", "设计"]}) == ["做页面"]
    assert titles(data, where={"tags": {"in": ["后端", "前端"]}}) == ["实现 CLI", "做页面"]
    assert titles(data, where={"tags": {"nin": ["设计"]}}) == ["实现 CLI"]


def test_or_and_system_fields(data):
    assert titles(data, where={"$or": [{"status": "完成"}, {"points": 3}]}) == ["写设计文档", "做页面"]
    assert titles(data, where={"$and": [{"_created_by": "claude"}, {"_id": {"gt": 1}}]}) == ["实现 CLI", "做页面"]


def test_sort_limit_offset(data):
    assert titles(data, sort="-points") == ["做页面", "实现 CLI", "写设计文档"]
    result = data("POST", "/tables/task/query", {"sort": "-points", "limit": 1, "offset": 1})
    assert [r["title"] for r in result["items"]] == ["实现 CLI"] and result["total"] == 3


def test_query_errors(data):
    err = data.err("POST", "/tables/task/query", {"where": {"nope": 1}})
    assert err["code"] == "invalid_query" and "title" in err["hint"]
    assert "运算符" in data.err("POST", "/tables/task/query", {"where": {"title": {"like": "x"}}})["hint"]
    assert "待办" in data.err("POST", "/tables/task/query", {"where": {"status": "done"}})["hint"]
    assert data.err("POST", "/tables/task/query", {"sort": "-nope"})["code"] == "invalid_query"
    assert data.err("POST", "/tables/task/query", {"include": "nope"})["code"] == "invalid_query"
    assert data.err("POST", "/tables/task/query", {"limit": 0})["code"] == "invalid_query"
    assert data.err("POST", "/tables/task/query", {"where": {"title": "a"}, "limit": "x"})["code"] == "invalid_request"


def test_query_children_by_parent(data):
    t = data.query("task")[0]
    data.insert("task_log", {"content": "a"}, t["_id"])
    data.insert("task_log", {"content": "b"}, data.query("task")[1]["_id"])
    assert [r["content"] for r in data.query("task_log", parent_id=t["_id"])] == ["a"]
    rows = data.query("task", include="task_log", where={"_id": t["_id"]})
    assert [l["content"] for l in rows[0]["task_log"]] == ["a"]
