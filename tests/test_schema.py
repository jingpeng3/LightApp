import copy

from conftest import TASK_SPEC


def spec_with(**changes):
    spec = copy.deepcopy(TASK_SPEC)
    spec.update(changes)
    return spec


def fields_of(api, table):
    return {f["key"]: f for f in api("GET", f"/tables/{table}")["fields"]}


def test_apply_creates_tree(api):
    result = api.apply(TASK_SPEC)
    assert result["applied"]
    assert [s["op"] for s in result["plan"]] == ["create_table"] * 4
    schema = result["schema"]
    assert [c["name"] for c in schema["children"]] == ["task_log", "task_board"]
    assert schema["children"][0]["children"][0]["name"] == "log_note"
    assert schema["children"][1]["relation"] == "one_to_one"
    status = fields_of(api, "task")["status"]
    assert status["options"][0] == {"value": "待办", "color": "gray"}
    assert all(o["color"] for o in status["options"])
    assert {t["name"] for t in api("GET", "/tables")} == {"task", "task_log", "log_note", "task_board"}


def test_dry_run_does_not_write(api):
    result = api.apply(TASK_SPEC, dry_run=True)
    assert not result["applied"] and len(result["plan"]) == 4
    assert api("GET", "/tables") == []


def test_reapply_same_spec_is_noop(task_api):
    assert task_api.apply(TASK_SPEC)["plan"] == []
    assert task_api("GET", "/tables/task")["schema_version"] == 1


def test_invalid_spec_has_hint(api):
    err = api.err("POST", "/tables/apply", {"spec": {"name": "Task"}})
    assert err["code"] == "invalid_spec" and "小写字母" in err["hint"]
    err = api.err("POST", "/tables/apply", {"spec": {"name": "t", "fields": [{"key": "a", "type": "money"}]}})
    assert "auto_number" in err["hint"]
    err = api.err("POST", "/tables/apply", {"spec": {"name": "t", "fields": [{"key": "a", "type": "single_select"}]}})
    assert "options" in err["message"]
    err = api.err("POST", "/tables/apply", {"spec": {"name": "t", "fields": [{"key": "c", "type": "text"}], "children": [{"name": "c"}]}})
    assert "重名" in err["message"]


def test_add_option_is_safe_remove_option_needs_force(task_api):
    spec = spec_with()
    spec["fields"][2]["options"] = ["待办", "进行中", "完成", "阻塞"]
    result = task_api.apply(spec)
    assert [s["op"] for s in result["plan"]] == ["update_field"]
    status = fields_of(task_api, "task")["status"]
    assert status["options"][0]["color"] == "gray"  # 没写颜色时沿用原来的颜色

    rec = task_api.insert("task", {"title": "a", "status": "阻塞"})
    spec["fields"][2]["options"] = ["待办", "进行中", "完成"]
    err = task_api.err("POST", "/tables/apply", {"spec": spec})
    assert err["code"] == "destructive_change" and err["details"]["plan"][0]["destructive"]
    task_api.apply(spec, force=True)
    assert task_api("GET", f"/tables/task/records/{rec['_id']}")["status"] is None


def test_archive_and_restore_field_keeps_data(task_api):
    rec = task_api.insert("task", {"title": "a", "points": 3})
    spec = spec_with(fields=[f for f in TASK_SPEC["fields"] if f["key"] != "points"])
    assert task_api.err("POST", "/tables/apply", {"spec": spec})["code"] == "destructive_change"
    task_api.apply(spec, force=True)
    got = task_api("GET", f"/tables/task/records/{rec['_id']}")
    assert "points" not in got
    assert task_api("GET", "/tables/task")["archived_fields"] == ["points"]

    plan = task_api.apply(TASK_SPEC)["plan"]
    assert {s["op"] for s in plan} == {"restore_field", "reorder_fields"}
    assert task_api("GET", f"/tables/task/records/{rec['_id']}")["points"] == 3
    assert list(fields_of(task_api, "task")) == [f["key"] for f in TASK_SPEC["fields"]]


def test_change_type_converts_values(api):
    api.apply({"name": "t", "fields": [{"key": "v", "type": "text"}]})
    a = api.insert("t", {"v": "42"})
    b = api.insert("t", {"v": "abc"})
    api.apply({"name": "t", "fields": [{"key": "v", "type": "number"}]}, force=True)
    assert api("GET", f"/tables/t/records/{a['_id']}")["v"] == 42
    assert api("GET", f"/tables/t/records/{b['_id']}")["v"] is None
    assert api("GET", "/tables/t")["schema_version"] == 2


def test_multiple_to_single_keeps_first(api):
    api.apply({"name": "t", "fields": [{"key": "tags", "type": "multi_select", "options": ["a", "b"]}]})
    rec = api.insert("t", {"tags": ["b", "a"]})
    api.apply({"name": "t", "fields": [{"key": "tags", "type": "single_select", "options": ["a", "b"]}]}, force=True)
    assert api("GET", f"/tables/t/records/{rec['_id']}")["tags"] == "b"


def test_cannot_change_parent(task_api):
    spec = {"name": "other", "children": [{"name": "task_log", "fields": TASK_SPEC["children"][0]["fields"]}]}
    err = task_api.err("POST", "/tables/apply", {"spec": spec})
    assert err["code"] == "not_allowed"
    assert task_api("GET", "/tables") and all(t["name"] != "other" for t in task_api("GET", "/tables"))


def test_missing_child_is_kept(task_api):
    plan = task_api.apply(spec_with(children=TASK_SPEC["children"][:1]))["plan"]
    assert plan == [{"op": "keep_child", "table": "task_board", "detail": plan[0]["detail"], "destructive": False}]


def test_add_child_to_existing_table_via_parent(task_api):
    task_api.apply({"name": "task_tag", "parent": "task", "fields": [{"key": "name", "type": "text"}]})
    assert task_api("GET", "/tables/task_tag")["parent"] == "task"
    assert "task_tag" in task_api("GET", "/tables/task")["children"][-1]["name"]


def test_new_auto_number_and_default_backfill(api):
    api.apply({"name": "t", "fields": [{"key": "a", "type": "text"}]})
    ids = [api.insert("t", {"a": str(i)})["_id"] for i in range(3)]
    api.apply({"name": "t", "fields": [
        {"key": "a", "type": "text"}, {"key": "no", "type": "auto_number"},
        {"key": "s", "type": "single_select", "options": ["x", "y"], "default": "x"},
    ]})
    rows = api.query("t")
    assert [r["no"] for r in rows] == [1, 2, 3] and {r["s"] for r in rows} == {"x"}
    assert api.insert("t", {"a": "new"})["no"] == 4
    assert [r["_id"] for r in rows] == ids


def test_unique_with_duplicates_fails(api):
    api.apply({"name": "t", "fields": [{"key": "a", "type": "text"}]})
    api.insert("t", {"a": "x"})
    api.insert("t", {"a": "x"})
    err = api.err("POST", "/tables/apply", {"spec": {"name": "t", "fields": [{"key": "a", "type": "text", "unique": True}]}})
    assert err["code"] == "unique_violation"
    assert "unique" not in api("GET", "/tables/t")["fields"][0]


def test_field_add(task_api):
    f = task_api("POST", "/tables/task/fields", {"key": "priority", "type": "single_select", "options": ["高", "低"]})
    assert f["options"][0]["color"]
    assert task_api.err("POST", "/tables/task/fields", {"key": "priority", "type": "text"})["code"] == "already_exists"
    assert "重名" in task_api.err("POST", "/tables/task/fields", {"key": "task_log", "type": "text"})["message"]


def test_drop_table(task_api):
    rec = task_api.insert("task", {"title": "a", "task_log": [{"content": "x"}]})
    err = task_api.err("DELETE", "/tables/task")
    assert err["code"] == "destructive_change" and err["details"]["tables"]["task_log"] == 1
    assert task_api("DELETE", "/tables/task", force="true")["dropped"]["task"] == 1
    assert task_api("GET", "/tables") == []
    assert rec


def test_drop_refused_when_linked(task_api):
    task_api.apply({"name": "bug", "fields": [{"key": "task", "type": "link", "config": {"table": "task"}}]})
    assert task_api.err("DELETE", "/tables/task", force="true")["code"] == "not_allowed"


def test_link_to_unknown_table(api):
    err = api.err("POST", "/tables/apply", {"spec": {"name": "t", "fields": [{"key": "x", "type": "link", "config": {"table": "nope"}}]}})
    assert "nope" in err["message"]


def test_cli_yaml_keeps_yes_no_as_strings():
    import yaml

    from dt.cli import _Loader

    spec = yaml.load("fields:\n  - {key: no, type: auto_number, required: true}\n  - {key: s, options: [yes, on, off]}\n", Loader=_Loader)
    assert spec["fields"][0] == {"key": "no", "type": "auto_number", "required": True}
    assert spec["fields"][1]["options"] == ["yes", "on", "off"]
