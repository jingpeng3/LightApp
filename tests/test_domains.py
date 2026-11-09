import sqlite3

import pytest

from conftest import TASK_SPEC
from dt.db import Database

PROJECT = {
    "name": "proj_a",
    "label": "项目 A",
    "tables": [
        TASK_SPEC,
        {"name": "bug", "fields": [
            {"key": "title", "type": "text"},
            {"key": "task", "type": "link", "config": {"table": "task", "multiple": True}},
        ]},
    ],
}


def test_domain_apply_creates_all_tables(api):
    result = api("POST", "/domains/apply", {"spec": PROJECT})
    assert result["plan"][0]["op"] == "create_domain"
    assert [t["name"] for t in result["domain"]["tables"]] == ["task", "bug"]
    assert result["domain"]["table_count"] == 5
    assert api("POST", "/domains/apply", {"spec": PROJECT})["plan"] == []
    assert {d["name"] for d in api("GET", "/domains")} == {"w", "proj_a"}


def test_dry_run_new_domain(api):
    plan = api("POST", "/domains/apply", {"spec": PROJECT, "dry_run": True})["plan"]
    assert [s["op"] for s in plan][:2] == ["create_domain", "create_table"]
    assert all(d["name"] != "proj_a" for d in api("GET", "/domains"))


def test_same_table_name_in_two_domains_is_isolated(api):
    for name in ("proj_a", "proj_b"):
        api("POST", "/domains/apply", {"spec": {**PROJECT, "name": name}})
    a, b = api.on("proj_a"), api.on("proj_b")
    rec = a.insert("task", {"title": "A 的任务", "task_log": [{"content": "x"}]})
    b.insert("task", {"title": "B 的任务"})
    assert [r["title"] for r in a.query("task")] == ["A 的任务"]
    assert [r["title"] for r in b.query("task")] == ["B 的任务"]
    # 用 B 域访问 A 的记录 id 会找不到
    assert b.err("GET", f"/tables/task/records/{rec['_id']}")["code"] == "not_found"
    assert b.err("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": "x"}})["code"] == "not_found"
    # link 只能引用本域的记录
    assert b.err("POST", "/tables/bug/records", {"data": {"task": [rec["_id"]]}})["code"] == "invalid_value"
    # 变更历史按域隔离
    assert {c["table_name"] for c in b("GET", "/changes") if c["record_id"]} == {"task"}
    assert all(c["domain"] == "proj_b" for c in b("GET", "/changes"))


def test_link_cannot_cross_domains(api):
    api("POST", "/domains/apply", {"spec": PROJECT})
    err = api.err("POST", "/tables/apply", {"spec": {"name": "x", "fields": [{"key": "t", "type": "link", "config": {"table": "task"}}]}})
    assert "同一个域" in err["hint"]


def test_unknown_domain(api):
    err = api.on("nope").err("GET", "/tables")
    assert err["code"] == "not_found" and "w" in err["hint"]
    assert api.err("POST", "/domains", {"name": "w"})["code"] == "already_exists"
    assert api.err("POST", "/domains", {"name": "Bad"})["code"] == "invalid_spec"


def test_missing_root_table_is_kept(api):
    api("POST", "/domains/apply", {"spec": PROJECT})
    plan = api("POST", "/domains/apply", {"spec": {**PROJECT, "tables": PROJECT["tables"][:1]}})["plan"]
    assert [s["op"] for s in plan] == ["keep_table"]


def test_drop_domain(api):
    api("POST", "/domains/apply", {"spec": PROJECT})
    api.on("proj_a").insert("task", {"title": "a", "task_log": [{"content": "x"}]})
    err = api.err("DELETE", "/domains/proj_a")
    assert err["code"] == "destructive_change" and err["details"]["tables"]["task_log"] == 1
    assert api("DELETE", "/domains/proj_a", force="true")["tables"]["task"] == 1
    assert [d["name"] for d in api("GET", "/domains")] == ["w"]


def test_ws_filters_by_domain(api):
    for name in ("proj_a", "proj_b"):
        api("POST", "/domains/apply", {"spec": {**PROJECT, "name": name}})
    with api.client.websocket_connect("/api/ws?domain=proj_a") as ws:
        ws.receive_json()
        api.on("proj_b").insert("task", {"title": "b"})
        api.on("proj_a").insert("task", {"title": "a"})
        api("POST", "/domains", {"name": "proj_c"})
        first, second = ws.receive_json()["change"], ws.receive_json()["change"]
        assert first["domain"] == "proj_a" and first["after"]["title"] == "a"
        assert second["op"] == "create_domain"  # 其他域的建域事件也会推送，页面据此刷新域列表


def test_migrate_legacy_db(tmp_path):
    """没有域的旧库：先备份，再把已有的表放进 default 域，记录和 id 不变。"""
    path = tmp_path / "dt.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
    CREATE TABLE dt_tables (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, label TEXT, description TEXT,
      parent_id INTEGER REFERENCES dt_tables(id), relation TEXT NOT NULL DEFAULT 'one_to_many',
      on_delete TEXT NOT NULL DEFAULT 'cascade', schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE dt_fields (id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES dt_tables(id) ON DELETE CASCADE,
      key TEXT NOT NULL, label TEXT, description TEXT, type TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0,
      uniq INTEGER NOT NULL DEFAULT 0, default_value TEXT, options TEXT, config TEXT, position INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, UNIQUE (table_id, key));
    CREATE TABLE dt_records (id INTEGER PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES dt_tables(id),
      parent_id INTEGER REFERENCES dt_records(id), data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT, updated_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE dt_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx TEXT NOT NULL, table_name TEXT NOT NULL,
      record_id INTEGER, op TEXT NOT NULL, before TEXT, after TEXT, actor TEXT, ts TEXT NOT NULL);
    CREATE INDEX ix_changes_record ON dt_changes (table_name, record_id);
    INSERT INTO dt_tables VALUES (1, 'task', '任务', NULL, NULL, 'one_to_many', 'cascade', 1, 't', 't');
    INSERT INTO dt_tables VALUES (2, 'task_log', NULL, NULL, 1, 'one_to_many', 'cascade', 1, 't', 't');
    INSERT INTO dt_fields (table_id, key, type) VALUES (1, 'title', 'text');
    INSERT INTO dt_records VALUES (7, 1, NULL, '{"title":"旧任务"}', 1, 'claude', 'claude', 't', 't');
    INSERT INTO dt_records VALUES (8, 2, 7, '{}', 1, 'claude', 'claude', 't', 't');
    INSERT INTO dt_changes (tx, table_name, record_id, op, ts) VALUES ('x', 'task', 7, 'insert', 't');
    """)
    conn.close()
    db = Database(path)
    from fastapi.testclient import TestClient

    from conftest import Api
    from dt.server import create_app

    with TestClient(create_app(db)) as client:
        api = Api(client, "default")
        assert [d["name"] for d in api("GET", "/domains")] == ["default"]
        assert api("GET", "/tables/task_log")["parent"] == "task"
        assert api("GET", "/tables/task/records/7")["title"] == "旧任务"
        assert api("GET", "/changes")[0]["domain"] == "default"
        api.insert("task", {"title": "新任务"})
    assert len(list(tmp_path.glob("dt.db.bak-*"))) == 1
    Database(path)  # 再次打开不会重复迁移
    assert len(list(tmp_path.glob("dt.db.bak-*"))) == 1


def test_progressive_disclosure(api):
    """dt domain show 只给表的概要；dt table show 才给字段。"""
    spec = {**PROJECT, "description": "项目 A"}
    result = api("POST", "/domains/apply", {"spec": spec})
    assert "表 task 没有 description，agent 只能靠表名猜它的用途" in result["warnings"]
    shown = api("GET", "/domains/proj_a")
    task = shown["tables"][0]
    assert "fields" not in task and [c["name"] for c in task["children"]] == ["task_log", "task_board"]
    assert task["children"][0]["children"][0]["name"] == "log_note"
    assert task["children"][1]["relation"] == "one_to_one"
    brief = api.on("proj_a")("GET", "/tables", brief="true")
    assert [t["name"] for t in brief] == ["task", "bug"] and "fields" not in brief[0]
    full = api.on("proj_a")("GET", "/tables/task")
    assert full["fields"] and "fields" not in full["children"][0]


def test_description_warnings_clear_when_filled(api):
    spec = {"name": "t", "description": "说明", "fields": [{"key": "a", "type": "text", "label": "A"}]}
    assert api("POST", "/tables/apply", {"spec": spec})["warnings"] == []
    spec["fields"].append({"key": "b", "type": "text"})
    assert api("POST", "/tables/apply", {"spec": spec, "dry_run": True})["warnings"] == ["字段 t.b 没有 label 和 description"]
