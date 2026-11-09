import pytest


def test_ws_pushes_changes_and_replays_since(task_api):
    with task_api.client.websocket_connect("/api/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        rec = task_api.insert("task", {"title": "a"})
        task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"status": "完成"}}, actor="claude")
        first, second = ws.receive_json(), ws.receive_json()
        assert first["change"]["op"] == "insert" and first["change"]["record_id"] == rec["_id"]
        assert second["change"]["actor"] == "claude" and second["change"]["after"]["status"] == "完成"
    # 断线后按 seq 补拉
    with task_api.client.websocket_connect(f"/api/ws?since={hello['seq']}") as ws:
        assert ws.receive_json()["seq"] == hello["seq"]
        assert [ws.receive_json()["change"]["op"] for _ in range(2)] == ["insert", "update"]


def test_ws_rejects_foreign_origin(task_api):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with task_api.client.websocket_connect("/api/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()


def test_foreign_host_rejected(task_api):
    assert task_api.client.get("/api/tables", headers={"host": "evil.example"}).status_code == 400


@pytest.fixture
def rec(task_api, tmp_path):
    (tmp_path / "report.md").write_text("# 报告")
    site = tmp_path / "site"
    (site / "css").mkdir(parents=True)
    (site / "index.html").write_text("<script>alert(1)</script>")
    (site / "css" / "a.css").write_text("body{}")
    (tmp_path / "secret.txt").write_text("secret")
    return task_api.insert("task", {"title": "a", "output": [str(tmp_path / "report.md"), str(site)]}), tmp_path


def test_read_file_and_dir(task_api, rec):
    r, tmp = rec
    resp = task_api.client.get(f"/api/files/{r['_id']}/output/0")
    assert resp.status_code == 200 and resp.text == "# 报告" and resp.headers["content-security-policy"] == "sandbox"
    tree = task_api("GET", f"/files/{r['_id']}/output/1/tree")
    assert [f["path"] for f in tree["files"]] == ["index.html", "css/a.css"]
    assert task_api.client.get(f"/api/files/{r['_id']}/output/1", params={"sub": "css/a.css"}).text == "body{}"


def test_file_access_is_confined(task_api, rec):
    r, tmp = rec
    get = lambda path, **p: task_api.client.get(f"/api/files/{r['_id']}/{path}", params=p)
    assert get("output/1", sub="../secret.txt").status_code == 403
    assert get("output/1", sub=str(tmp / "secret.txt")).status_code == 403
    assert get("output/1").status_code == 400
    assert get("output/5").status_code == 404
    assert get("title/0").status_code == 400
    (tmp / "site" / "link.txt").symlink_to(tmp / "secret.txt")
    assert get("output/1", sub="link.txt").status_code == 403


def test_status_missing_and_changed(task_api, rec):
    r, tmp = rec
    body = {"record_ids": [r["_id"], 999]}
    assert task_api("POST", "/files/status", body) == {str(r["_id"]): {"output": ["ok", "ok"]}}
    (tmp / "report.md").write_text("# 改过了")
    assert task_api("POST", "/files/status", body)[str(r["_id"])]["output"] == ["changed", "ok"]
    (tmp / "report.md").unlink()
    assert task_api("POST", "/files/status", body)[str(r["_id"])]["output"] == ["missing", "ok"]
