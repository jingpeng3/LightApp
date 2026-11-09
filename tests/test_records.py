def test_insert_defaults_and_system_fields(task_api):
    rec = task_api.insert("task", {"title": "写设计", "tags": "前端", "points": "2.5"})
    assert rec["no"] == 1 and rec["status"] == "待办" and rec["tags"] == ["前端"] and rec["points"] == 2.5
    assert rec["done"] is False and rec["_version"] == 1 and rec["_created_by"] == "tester"
    assert task_api.insert("task", {"title": "b"})["no"] == 2


def test_validation_errors_have_hints(task_api):
    err = task_api.err("POST", "/tables/task/records", {"data": {"status": "完成"}})
    assert err["code"] == "required" and "title" in err["message"]
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "status": "done"}})
    assert err["code"] == "invalid_value" and "待办、进行中、完成" in err["hint"]
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "nope": 1}})
    assert err["code"] == "unknown_field" and "title" in err["hint"]
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "due": "2026/11/06"}})
    assert "YYYY-MM-DD" in err["hint"]
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "no": 5}})
    assert err["code"] == "readonly_field"
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "_id": 5}})
    assert err["code"] == "readonly_field"


def test_nested_insert_and_include(task_api):
    rec = task_api.insert("task", {
        "title": "a",
        "task_log": [{"content": "开始", "log_note": [{"text": "n1"}, {"text": "n2"}]}, {"content": "继续"}],
        "task_board": {"column": "Doing"},
    })
    assert len(rec["task_log"]) == 2 and rec["task_log"][0]["log_note"][1]["text"] == "n2"
    assert rec["task_board"]["_parent_id"] == rec["_id"]
    got = task_api("GET", f"/tables/task/records/{rec['_id']}", include="task_log,task_log.log_note,task_board")
    assert [l["content"] for l in got["task_log"]] == ["开始", "继续"]
    assert len(got["task_log"][0]["log_note"]) == 2 and got["task_log"][1]["log_note"] == []
    assert got["task_board"]["column"] == "Doing"
    plain = task_api("GET", f"/tables/task/records/{rec['_id']}")
    assert "task_log" not in plain


def test_nested_insert_is_atomic(task_api):
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "task_log": [{"content": "ok"}, {"level": "info"}]}})
    assert err["code"] == "required"
    assert task_api.query("task") == [] and task_api.query("task_log") == []


def test_child_needs_parent_and_one_to_one(task_api):
    err = task_api.err("POST", "/tables/task_log/records", {"data": {"content": "x"}})
    assert err["code"] == "parent_required" and "--parent" in err["hint"]
    assert task_api.err("POST", "/tables/task_log/records", {"data": {"content": "x"}, "parent_id": 999})["code"] == "not_found"
    parent = task_api.insert("task", {"title": "a"})
    task_api.insert("task_board", {"column": "Doing"}, parent["_id"])
    err = task_api.err("POST", "/tables/task_board/records", {"data": {"column": "Done"}, "parent_id": parent["_id"]})
    assert err["code"] == "one_to_one_conflict"
    assert task_api.err("POST", "/tables/task/records", {"data": {"title": "x"}, "parent_id": parent["_id"]})["code"] == "invalid_value"


def test_update_and_optimistic_lock(task_api):
    rec = task_api.insert("task", {"title": "a", "points": 1})
    upd = task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成", "points": None}}, actor="claude")
    assert upd["status"] == "完成" and upd["points"] is None and upd["_version"] == 2 and upd["_updated_by"] == "claude"
    same = task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}})
    assert same["_version"] == 2
    err = task_api.err("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": "b"}, "if_version": 1})
    assert err["code"] == "version_conflict" and "dt rec get" in err["hint"]
    assert task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": "b"}, "if_version": 2})["_version"] == 3
    assert task_api.err("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": None}})["code"] == "required"


def test_delete_cascade_and_restrict(task_api):
    rec = task_api.insert("task", {"title": "a", "task_log": [{"content": "x", "log_note": [{"text": "n"}]}], "task_board": {}})
    deleted = task_api("DELETE", f"/tables/task/records/{rec['_id']}")["deleted"]
    assert {d["table"] for d in deleted} == {"task", "task_log", "log_note", "task_board"}
    assert task_api.query("log_note") == []

    task_api.apply({"name": "proj", "children": [{"name": "member", "on_delete": "restrict", "fields": [{"key": "n", "type": "text"}]}]})
    proj = task_api.insert("proj", {"member": [{"n": "a"}]})
    assert task_api.err("DELETE", f"/tables/proj/records/{proj['_id']}")["code"] == "restrict_violation"
    task_api("DELETE", f"/tables/member/records/{proj['member'][0]['_id']}")
    task_api("DELETE", f"/tables/proj/records/{proj['_id']}")


def test_link_validate_and_cleanup(task_api):
    task_api.apply({"name": "bug", "fields": [
        {"key": "task", "type": "link", "config": {"table": "task"}},
        {"key": "related", "type": "link", "config": {"table": "task", "multiple": True}},
    ]})
    a, b = task_api.insert("task", {"title": "a"}), task_api.insert("task", {"title": "b"})
    assert task_api.err("POST", "/tables/bug/records", {"data": {"task": 999}})["code"] == "invalid_value"
    bug = task_api.insert("bug", {"task": a["_id"], "related": [a["_id"], str(b["_id"])]})
    assert bug["related"] == [a["_id"], b["_id"]]
    task_api("DELETE", f"/tables/task/records/{a['_id']}")
    got = task_api("GET", f"/tables/bug/records/{bug['_id']}")
    assert got["task"] is None and got["related"] == [b["_id"]]


def test_unique(api):
    api.apply({"name": "t", "fields": [{"key": "code", "type": "text", "unique": True}]})
    a = api.insert("t", {"code": "x"})
    assert api.err("POST", "/tables/t/records", {"data": {"code": "x"}})["code"] == "unique_violation"
    api("PATCH", f"/tables/t/records/{a['_id']}", {"set": {"code": "x"}})


def test_batch_is_atomic(task_api):
    err = task_api.err("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b", "status": "x"}]})
    assert err["message"].startswith("第 2 条")
    assert task_api.query("task") == []
    assert len(task_api("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b"}]})) == 2


def test_changes_log(task_api):
    rec = task_api.insert("task", {"title": "a", "task_log": [{"content": "x"}]}, )
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}}, actor="claude")
    changes = task_api("GET", "/changes", table="task", record_id=rec["_id"])
    assert [c["op"] for c in changes] == ["insert", "update"]
    assert changes[1]["before"]["status"] == "待办" and changes[1]["after"]["status"] == "完成" and changes[1]["actor"] == "claude"
    all_changes = task_api("GET", "/changes", limit=100)
    since = task_api("GET", "/changes", since=all_changes[-2]["seq"])
    assert since == all_changes[-1:]
    assert sum(c["op"] == "create_table" for c in all_changes) == 4
