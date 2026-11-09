import pytest


@pytest.fixture
def files(tmp_path):
    (tmp_path / "report.md").write_text("# 报告")
    (tmp_path / "chart.png").write_bytes(b"\x89PNG")
    out = tmp_path / "site"
    (out / "assets").mkdir(parents=True)
    (out / "index.html").write_text("<h1>x</h1>")
    (out / "assets" / "a.css").write_text("body{}")
    return tmp_path


def test_file_and_dir_metadata(task_api, files):
    rec = task_api.insert("task", {"title": "a", "output": [str(files / "report.md"), str(files / "site")]})
    md, site = rec["output"]
    assert md["kind"] == "file" and md["name"] == "report.md" and md["mime"] == "text/markdown"
    assert len(md["sha256"]) == 64 and md["size"] == len("# 报告".encode()) and md["added_by"] == "tester"
    assert site["kind"] == "dir" and site["file_count"] == 2 and "sha256" not in site


def test_path_validation(task_api, files):
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "output": "report.md"}})
    assert "绝对路径" in err["message"]
    err = task_api.err("POST", "/tables/task/records", {"data": {"title": "a", "output": str(files / "nope.md")}})
    assert "不存在" in err["message"]
    task_api.apply({"name": "doc", "fields": [{"key": "f", "type": "attachment", "config": {"accept": ["MD"]}}]})
    err = task_api.err("POST", "/tables/doc/records", {"data": {"f": str(files / "chart.png")}})
    assert ".md" in err["hint"]
    assert task_api.insert("doc", {"f": str(files / "report.md")})["f"]["name"] == "report.md"
    assert task_api.insert("doc", {"f": str(files / "site")})["f"]["kind"] == "dir"  # accept 不约束目录
    assert task_api.err("POST", "/tables/doc/records", {"data": {"f": [str(files / "report.md")] * 2}})["code"] == "invalid_value"


def test_attach_appends_and_keeps_added_info(task_api, files):
    rec = task_api.insert("task", {"title": "a", "output": str(files / "report.md")})
    first = rec["output"][0]
    (files / "report.md").write_text("# 报告 v2")
    attached = task_api("POST", f"/tables/task/records/{rec['_id']}/attach",
                        {"field": "output", "paths": [str(files / "chart.png"), str(files / "report.md")]}, actor="claude")
    assert [o["name"] for o in attached["output"]] == ["report.md", "chart.png"]
    assert attached["output"][1]["added_by"] == "claude"

    upd = task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"output": [str(files / "report.md")]}}, actor="claude")
    again = upd["output"][0]
    assert again["added_by"] == "tester" and again["added_at"] == first["added_at"] and again["sha256"] != first["sha256"]

    # 原样传回已登记的附件对象（页面保存时）不会报错
    same = task_api("PATCH", f"/tables/task/records/{rec['_id']}", {"set": {"output": upd["output"]}})
    assert same["_version"] == upd["_version"]


def test_attach_to_single_field(task_api, files):
    task_api.apply({"name": "doc", "fields": [{"key": "f", "type": "attachment"}]})
    rec = task_api.insert("doc", {})
    got = task_api("POST", f"/tables/doc/records/{rec['_id']}/attach", {"field": "f", "paths": [str(files / "report.md")]})
    assert got["f"]["name"] == "report.md"
    err = task_api.err("POST", f"/tables/doc/records/{rec['_id']}/attach", {"field": "f", "paths": [str(files / "chart.png")]})
    assert "dt rec update" in err["hint"]


def test_query_attachment_by_path(task_api, files):
    task_api.insert("task", {"title": "a", "output": [str(files / "report.md")]})
    task_api.insert("task", {"title": "b"})
    rows = task_api.query("task", where={"output": {"contains": str(files / "report.md")}})
    assert [r["title"] for r in rows] == ["a"]
    assert [r["title"] for r in task_api.query("task", where={"output": {"is_null": True}})] == ["b"]
