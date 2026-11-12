import hashlib
import hmac
import json

from dt import events


def test_events_are_field_level(task_api):
    rec = task_api.insert("task", {"title": "a", "points": 1})
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成", "title": "b"}}, actor="claude")

    data = task_api("GET", "/events", table="task")
    insert, update = data["items"]
    assert [insert["op"], update["op"]] == ["insert", "update"]
    assert insert["fields"]["status"] == {"before": None, "after": "待办"}
    assert update["fields"] == {
        "status": {"before": "待办", "after": "完成"},
        "title": {"before": "a", "after": "b"},
    }
    assert update["actor"] == "claude" and update["record"]["points"] == 1

    only = task_api("GET", "/events", table="task", op="update", field="status")["items"]
    assert [e["seq"] for e in only] == [update["seq"]]


def test_event_cursor_advances_past_filtered_events(task_api):
    rec = task_api.insert("task", {"title": "a"})
    cursor = task_api("GET", "/events")["seq"]

    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": "b"}})
    skipped = task_api("GET", "/events", since=cursor, field="status")
    assert skipped["items"] == [] and skipped["seq"] > cursor

    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}})
    hit = task_api("GET", "/events", since=skipped["seq"], field="status")
    assert len(hit["items"]) == 1 and set(hit["items"][0]["fields"]) == {"status"}


def test_binding_where_and_where_before(task_api):
    rec = task_api.insert("task", {"title": "a"})
    task_api("POST", "/bindings", {
        "name": "done", "ops": ["update"], "table": "task", "field": "status",
        "where": {"status": "完成"}, "where_before": {"status": "待办"},
        "action": "command", "config": {"cmd": "cat > /dev/null"},
    })
    patch = lambda **values: task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": values}, actor="claude")

    patch(status="进行中")   # where 不满足
    patch(status="完成")     # where_before 不满足
    patch(title="x")         # 字段没变
    patch(status="待办")     # where 不满足
    assert task_api("GET", "/bindings/done/deliveries") == []

    patch(status="完成")     # 待办 → 完成，命中
    deliveries = task_api("GET", "/bindings/done/deliveries")
    assert len(deliveries) == 1 and deliveries[0]["status"] == "pending"


def test_delete_where_uses_before(task_api):
    rec = task_api.insert("task", {"title": "删我"})
    task_api("POST", "/bindings", {
        "name": "gone", "ops": ["delete"], "table": "task", "where": {"title": "删我"},
        "action": "command", "config": {"cmd": "cat > /dev/null"},
    })
    task_api("DELETE", f"/tables/task/records/{rec['_id']}")
    assert len(task_api("GET", "/bindings/gone/deliveries")) == 1


def test_write_action_can_update_records(task_api):
    rec = task_api.insert("task", {"title": "a"})
    task_api.apply({"name": "note", "fields": [{"key": "text", "type": "text"}]})
    note = task_api.insert("note", {"text": "旧值"})
    task_api("POST", "/bindings", {
        "name": "sync", "ops": ["update"], "table": "task", "field": "status",
        "action": "write",
        "config": {
            "table": "note", "mode": "update", "record_id": note["_id"],
            "data": {"text": "任务 ${record.title} 已完成"},
        },
    })
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}}, actor="claude")

    assert events.dispatch_once(task_api.db) == 1
    assert task_api("GET", f"/tables/note/records/{note['_id']}")["text"] == "任务 a 已完成"


def test_write_action_inserts_child_records(task_api):
    rec = task_api.insert("task", {"title": "a"})
    task_api("POST", "/bindings", {
        "name": "done", "ops": ["update"], "table": "task", "field": "status",
        "where": {"status": "完成"},
        "action": "write",
        "config": {
            "table": "task_log", "parent_id": "${event.record_id}",
            "data": {"content": "任务 ${record.title} 已完成", "level": "info"},
        },
    })
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}}, actor="claude")

    assert events.dispatch_once(task_api.db) == 1
    logs = task_api.query("task_log", parent_id=rec["_id"])
    assert [log["content"] for log in logs] == ["任务 a 已完成"]
    delivery = task_api("GET", "/bindings/done/deliveries")[0]
    assert delivery["status"] == "sent" and delivery["attempts"] == 1


def test_write_action_does_not_trigger_itself(task_api):
    rec = task_api.insert("task", {"title": "a"})
    task_api("POST", "/bindings", {
        "name": "auto", "ops": ["insert"], "table": "task_log",
        "action": "write",
        "config": {
            "table": "task_log", "parent_id": "${record._parent_id}",
            "data": {"content": "自动生成"},
        },
    })
    task_api.insert("task_log", {"content": "手动"}, rec["_id"])
    assert events.dispatch_once(task_api.db) == 1
    assert [log["content"] for log in task_api.query("task_log", parent_id=rec["_id"])] == ["手动", "自动生成"]
    # 绑定动作自己的写入不会再产生投递
    assert events.dispatch_once(task_api.db) == 0


def test_command_action_gets_event_on_stdin(task_api, tmp_path):
    out = tmp_path / "event.json"
    task_api("POST", "/bindings", {
        "name": "cmd", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": f"cat > {out}"},
    })
    rec = task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    event = json.loads(out.read_text())
    assert event["op"] == "insert" and event["record_id"] == rec["_id"] and event["record"]["title"] == "a"
    assert task_api("GET", "/bindings/cmd/deliveries")[0]["last_result"] == "退出码 0"


def test_binding_prompt_reaches_command(task_api, tmp_path):
    out = tmp_path / "prompt.txt"
    task_api("POST", "/bindings", {
        "name": "cmd", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": f'printf "%s" "$DT_PROMPT" > {out}'},
        "prompt": "任务 ${record.title} 已完成，操作者 ${event.actor}",
    })
    task_api("POST", "/tables/task/records", {"data": {"title": "a"}}, actor="claude")
    assert events.dispatch_once(task_api.db) == 1
    assert out.read_text() == "任务 a 已完成，操作者 claude"


def test_webhook_action_payload_and_signature(monkeypatch, task_api):
    calls = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            pass

    def post(url, content=None, headers=None, timeout=None):
        calls.append({"url": url, "body": json.loads(content), "raw": content, "headers": headers})
        return Response()

    monkeypatch.setattr(events.httpx, "post", post)
    task_api("POST", "/bindings", {
        "name": "hook", "ops": ["insert"], "table": "task",
        "action": "webhook",
        "config": {"url": "http://127.0.0.1:9000/hook", "secret": "s3cret"},
    })
    rec = task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1

    call = calls[0]
    assert call["url"] == "http://127.0.0.1:9000/hook"
    assert call["body"]["binding"] == "hook" and call["body"]["event"]["record_id"] == rec["_id"]
    assert call["headers"]["X-DT-Signature"] == hmac.new(
        b"s3cret", call["raw"].encode(), hashlib.sha256
    ).hexdigest()
    assert task_api("GET", "/bindings/hook/deliveries")[0]["last_result"] == "HTTP 200"


def test_webhook_action_carries_prompt(monkeypatch, task_api):
    calls = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            pass

    def post(url, content=None, headers=None, timeout=None):
        calls.append(json.loads(content))
        return Response()

    monkeypatch.setattr(events.httpx, "post", post)
    task_api("POST", "/bindings", {
        "name": "hook", "ops": ["insert"], "table": "task",
        "action": "webhook", "config": {"url": "http://127.0.0.1:9000/hook"},
        "prompt": "请检查 ${record.title}",
    })
    task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    assert calls[0]["prompt"] == "请检查 a"


def test_failed_delivery_backs_off(task_api):
    task_api("POST", "/bindings", {
        "name": "bad", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": "exit 3"},
    })
    task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    delivery = task_api("GET", "/bindings/bad/deliveries")[0]
    assert delivery["status"] == "pending" and delivery["attempts"] == 1
    assert delivery["next_attempt_at"] and "命令退出码 3" in delivery["last_error"]
    assert delivery["last_result"] is None
    assert events.dispatch_once(task_api.db) == 0  # 还没到下次重试时间


def test_binding_crud_and_validation(task_api):
    err = task_api.err("POST", "/bindings", {"name": "x", "field": "status", "action": "command", "config": {"cmd": "true"}})
    assert err["code"] == "invalid_binding"
    err = task_api.err("POST", "/bindings", {"name": "x", "action": "webhook", "config": {}})
    assert err["code"] == "invalid_binding"
    err = task_api.err("POST", "/bindings", {"name": "x", "action": "write", "config": {}})
    assert err["code"] == "invalid_binding"
    assert task_api.err("POST", "/bindings", {"name": "x", "action": "nope", "config": {}})["code"] == "invalid_binding"
    assert task_api.err("POST", "/bindings", {
        "name": "x", "table": "task", "field": "nope", "action": "command", "config": {"cmd": "true"},
    })["code"] == "invalid_binding"

    task_api("POST", "/bindings", {
        "name": "x", "table": "task", "field": "status",
        "action": "command", "config": {"cmd": "true"},
    })
    assert task_api.err("POST", "/bindings", {
        "name": "x", "action": "command", "config": {"cmd": "true"},
    })["code"] == "already_exists"
    assert task_api("PATCH", "/bindings/x", {"enabled": False})["enabled"] is False
    assert task_api("DELETE", "/bindings/x")["deleted"] == "x"
    assert task_api("GET", "/bindings") == []


def test_delivery_detail_includes_events(task_api):
    task_api("POST", "/bindings", {
        "name": "cmd", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": "cat > /dev/null"},
    })
    rec = task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    delivery = task_api("GET", "/bindings/cmd/deliveries")[0]
    detail = task_api("GET", f"/bindings/cmd/deliveries/{delivery['id']}")
    assert detail["status"] == "sent" and detail["last_result"] == "退出码 0"
    assert detail["created_at"] and detail["updated_at"]
    assert [event["seq"] for event in detail["events"]] == delivery["seqs"]
    assert detail["events"][0]["record_id"] == rec["_id"]
    assert task_api.err("GET", "/bindings/cmd/deliveries/999")["code"] == "not_found"


def test_ws_events_filters(task_api):
    with task_api.client.websocket_connect("/api/ws/events?domain=w&table=task&field=status&op=update") as ws:
        assert ws.receive_json()["type"] == "hello"
        rec = task_api.insert("task", {"title": "a"})                     # insert 被过滤
        task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"title": "b"}})   # status 没变，被过滤
        task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}})
        message = ws.receive_json()
        assert message["type"] == "event"
        assert message["event"]["record_id"] == rec["_id"]
        assert set(message["event"]["fields"]) == {"status"}


def test_batch_insert_coalesces_one_delivery(task_api):
    task_api("POST", "/bindings", {
        "name": "all", "table": "task", "action": "command", "config": {"cmd": "cat > /dev/null"},
    })
    task_api("POST", "/tables/task/records", {"rows": [{"title": f"t{i}"} for i in range(50)]})
    deliveries = task_api("GET", "/bindings/all/deliveries")
    assert len(deliveries) == 1
    assert deliveries[0]["event_count"] == 50 and len(deliveries[0]["seqs"]) == 50
    assert events.dispatch_once(task_api.db) == 1
    assert task_api("GET", "/bindings/all/deliveries")[0]["status"] == "sent"


def test_command_action_gets_jsonl_for_batch(task_api, tmp_path):
    out = tmp_path / "events.jsonl"
    task_api("POST", "/bindings", {
        "name": "cmd", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": f"cat > {out}"},
    })
    task_api("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b"}, {"title": "c"}]})
    assert events.dispatch_once(task_api.db) == 1
    lines = [json.loads(line) for line in out.read_text().splitlines()]
    assert [event["record"]["title"] for event in lines] == ["a", "b", "c"]
    delivery = task_api("GET", "/bindings/cmd/deliveries")[0]
    assert delivery["event_count"] == 3 and delivery["status"] == "sent"


def test_webhook_batch_payload(monkeypatch, task_api):
    calls = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            pass

    def post(url, content=None, headers=None, timeout=None):
        calls.append({"body": json.loads(content), "headers": headers})
        return Response()

    monkeypatch.setattr(events.httpx, "post", post)
    task_api("POST", "/bindings", {
        "name": "hook", "ops": ["insert"], "table": "task",
        "action": "webhook", "config": {"url": "http://127.0.0.1:9000/hook"},
    })
    task_api("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b"}]})
    assert events.dispatch_once(task_api.db) == 1
    body = calls[0]["body"]
    assert body["event_count"] == 2 and len(body["events"]) == 2
    assert "event" not in body
    assert calls[0]["headers"]["X-DT-Event-Count"] == "2"


def test_dispatch_groups_multiple_deliveries(task_api, tmp_path):
    out = tmp_path / "events.jsonl"
    task_api("POST", "/bindings", {
        "name": "cmd", "ops": ["insert"], "table": "task",
        "action": "command", "config": {"cmd": f"cat > {out}", "batch": 3},
    })
    for title in ("a", "b", "c"):
        task_api.insert("task", {"title": title})       # 三个独立事务 = 三条投递
    assert len(task_api("GET", "/bindings/cmd/deliveries")) == 3
    assert events.dispatch_once(task_api.db) == 3
    assert len(out.read_text().splitlines()) == 3
    assert all(d["status"] == "sent" for d in task_api("GET", "/bindings/cmd/deliveries"))


def test_write_action_handles_batch(task_api):
    task_api("POST", "/bindings", {
        "name": "log", "ops": ["insert"], "table": "task",
        "action": "write",
        "config": {
            "table": "task_log", "parent_id": "${event.record_id}",
            "data": {"content": "日志 ${record.title}"},
        },
    })
    task_api("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b"}]})
    assert events.dispatch_once(task_api.db) == 1
    assert [row["content"] for row in task_api.query("task_log")] == ["日志 a", "日志 b"]


def test_max_pending_drops_new_deliveries(task_api):
    task_api("POST", "/bindings", {
        "name": "cap", "table": "task", "action": "command",
        "config": {"cmd": "cat > /dev/null", "max_pending": 1},
    })
    for title in ("a", "b", "c"):
        task_api.insert("task", {"title": title})
    assert len(task_api("GET", "/bindings/cap/deliveries")) == 1


def test_prune_old_deliveries(task_api):
    task_api("POST", "/bindings", {
        "name": "old", "table": "task", "action": "command", "config": {"cmd": "true"},
    })
    task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    with task_api.db.tx("system") as tx:
        tx.execute("UPDATE dt_deliveries SET updated_at = '2000-01-01T00:00:00.000Z'")
    assert events.prune_deliveries(task_api.db)["sent"] == 1
    assert task_api("GET", "/bindings/old/deliveries") == []


def test_changes_store_field_diff(task_api):
    rec = task_api.insert("task", {"title": "a"})
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}})
    with task_api.db.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM dt_change_fields WHERE field = 'status'").fetchone()[0] >= 2
        row = conn.execute("SELECT fields FROM dt_changes WHERE op = 'update' ORDER BY seq DESC LIMIT 1").fetchone()
        assert json.loads(row["fields"]) == {"status": {"before": "待办", "after": "完成"}}
    items = task_api("GET", "/events", field="status")["items"]
    assert items and all("status" in event["fields"] for event in items)


def test_backfill_old_changes(tmp_path):
    from dt import domains, records, schema
    from dt.db import Database
    from dt.model import bind_domain, get_table

    path = tmp_path / "dt.db"
    db = Database(path)
    domains.create(db, {"name": "w"})
    schema.apply(db, "w", {"name": "task", "fields": [
        {"key": "title", "type": "text"},
        {"key": "status", "type": "single_select", "options": ["todo", "done"], "default": "todo"},
    ]}, actor="t")
    with db.tx("t") as tx:
        bind_domain(tx, "w")
        rec = records.insert(tx, get_table(tx.conn, tx.domain_id, "task"), {"title": "a"})
    with db.tx("t") as tx:
        bind_domain(tx, "w")
        records.update(tx, get_table(tx.conn, tx.domain_id, "task"), rec["_id"], {"status": "done"})
    # 模拟升级前的库
    db.conn.execute("ALTER TABLE dt_changes DROP COLUMN fields")
    db.conn.execute("DROP TABLE dt_change_fields")
    db.conn.close()

    reopened = Database(path)
    with reopened.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM dt_change_fields WHERE field = 'status'").fetchone()[0] >= 2
        missing = conn.execute(
            "SELECT COUNT(*) FROM dt_changes WHERE op IN ('insert', 'update', 'delete') AND fields IS NULL"
        ).fetchone()[0]
        assert missing == 0
        items, _ = events.list_events(conn, "w", field="status", limit=10)
        assert len(items) == 2
    reopened.conn.close()


def test_migrate_prompt_columns(tmp_path):
    from dt.db import Database

    path = tmp_path / "dt.db"
    db = Database(path)
    db.conn.execute("ALTER TABLE dt_bindings DROP COLUMN prompt")
    db.conn.execute("ALTER TABLE dt_inbox DROP COLUMN prompt")
    db.conn.close()

    reopened = Database(path)
    assert "prompt" in {r["name"] for r in reopened.conn.execute("PRAGMA table_info(dt_bindings)")}
    assert "prompt" in {r["name"] for r in reopened.conn.execute("PRAGMA table_info(dt_inbox)")}
    reopened.conn.close()


def test_inbox_action_defaults_and_read_state(task_api):
    task_api("POST", "/bindings", {
        "name": "inbox", "table": "task", "action": "inbox", "config": {},
    })
    rec = task_api.insert("task", {"title": "a"})
    task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}}, actor="claude")
    assert events.dispatch_once(task_api.db) == 2

    data = task_api("GET", "/inbox")
    assert data["unread"] == 2 and data["total"] == 2
    latest, first = data["items"]
    assert latest["title"].endswith("变更") and "status：待办 → 完成" in latest["body"]
    assert first["title"].endswith("新增") and "标题：空 → a" in first["body"]
    assert latest["events"][0]["record_id"] == rec["_id"]

    assert task_api("PATCH", f"/inbox/{latest['id']}", {"status": "read"})["status"] == "read"
    assert task_api("GET", "/inbox")["unread"] == 1
    assert task_api("POST", "/inbox/read-all")["updated"] == 1
    assert task_api("GET", "/inbox")["unread"] == 0
    assert task_api("DELETE", f"/inbox/{latest['id']}")["deleted"] == latest["id"]
    assert task_api("GET", "/inbox")["total"] == 1


def test_inbox_templates_and_batch(task_api):
    task_api("POST", "/bindings", {
        "name": "inbox", "table": "task", "action": "inbox",
        "config": {
            "title": "${record.title} → ${fields.status.after}",
            "body": "操作者 ${event.actor}，事件 #${event.seq}",
        },
        "prompt": "请处理 ${record.title}",
    })
    task_api("POST", "/tables/task/records", {"rows": [{"title": "a"}, {"title": "b"}]})
    assert events.dispatch_once(task_api.db) == 1
    messages = task_api("GET", "/inbox")["items"]
    assert [m["title"] for m in messages] == ["b → 待办", "a → 待办"]
    assert all("事件 #" in m["body"] for m in messages)
    assert [m["prompt"] for m in messages] == ["请处理 b", "请处理 a"]
    assert task_api("GET", "/bindings/inbox/deliveries")[0]["last_result"] == "写入 2 条"


def test_binding_prompt_validation_and_update(task_api):
    assert task_api.err("POST", "/bindings", {
        "name": "x", "table": "task", "action": "command", "config": {"cmd": "true"}, "prompt": 3,
    })["code"] == "invalid_binding"
    task_api("POST", "/bindings", {
        "name": "x", "table": "task", "action": "command", "config": {"cmd": "true"}, "prompt": "hi",
    })
    assert task_api("GET", "/bindings")[0]["prompt"] == "hi"
    assert task_api("PATCH", "/bindings/x", {"prompt": "yo ${record.title}"})["prompt"] == "yo ${record.title}"
    assert task_api("PATCH", "/bindings/x", {"prompt": None})["prompt"] is None


def test_inbox_retry_does_not_duplicate(task_api):
    task_api("POST", "/bindings", {
        "name": "inbox", "table": "task", "action": "inbox", "config": {},
    })
    task_api.insert("task", {"title": "a"})
    assert events.dispatch_once(task_api.db) == 1
    with task_api.db.tx("system") as tx:
        tx.execute("UPDATE dt_deliveries SET status = 'pending', attempts = 0")
    assert events.dispatch_once(task_api.db) == 1
    assert task_api("GET", "/inbox")["total"] == 1


def test_inbox_validation(task_api):
    err = task_api.err("POST", "/bindings", {
        "name": "x", "table": "task", "action": "inbox", "config": {"title": 3},
    })
    assert err["code"] == "invalid_binding"
    task_api("POST", "/bindings", {"name": "x", "table": "task", "action": "inbox", "config": {}})
    assert task_api.err("PATCH", "/inbox/999", {"status": "read"})["code"] == "not_found"
    assert task_api.err("PATCH", "/inbox/1", {"status": "nope"})["code"] == "invalid_value"



