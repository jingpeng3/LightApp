import pytest
from fastapi.testclient import TestClient

from dt.db import Database
from dt.server import create_app

TASK_SPEC = {
    "name": "task",
    "label": "任务",
    "fields": [
        {"key": "no", "type": "auto_number"},
        {"key": "title", "label": "标题", "type": "text", "required": True},
        {"key": "status", "type": "single_select", "options": [{"value": "待办", "color": "gray"}, "进行中", "完成"], "default": "待办"},
        {"key": "tags", "type": "multi_select", "options": ["前端", "后端", "设计"]},
        {"key": "due", "type": "date"},
        {"key": "points", "type": "number"},
        {"key": "done", "type": "checkbox"},
        {"key": "output", "type": "attachment", "config": {"multiple": True}},
    ],
    "children": [
        {
            "name": "task_log",
            "fields": [
                {"key": "content", "type": "long_text", "required": True},
                {"key": "level", "type": "single_select", "options": ["info", "warn", "error"]},
            ],
            "children": [{"name": "log_note", "fields": [{"key": "text", "type": "text"}]}],
        },
        {"name": "task_board", "relation": "one_to_one", "fields": [{"key": "column", "type": "single_select", "options": ["Backlog", "Doing", "Done"]}]},
    ],
}


class Api:
    """测试用客户端。/tables、/changes、/events、/bindings 开头的路径自动加上当前域的前缀。"""

    def __init__(self, client: TestClient, domain: str = "w", db: Database | None = None):
        self.client = client
        self.domain = domain
        self.db = db

    def on(self, domain: str) -> "Api":
        return Api(self.client, domain, self.db)

    def raw(self, method, path, body=None, actor="tester", **params):
        if path.startswith(("/tables", "/changes", "/events", "/bindings", "/inbox")):
            path = f"/d/{self.domain}{path}"
        return self.client.request(method, "/api" + path, json=body, params=params or None, headers={"X-DT-Actor": actor}).json()

    def __call__(self, method, path, body=None, **kw):
        resp = self.raw(method, path, body, **kw)
        assert resp["ok"], resp
        return resp["data"]

    def err(self, method, path, body=None, **kw) -> dict:
        resp = self.raw(method, path, body, **kw)
        assert not resp["ok"], resp
        return resp["error"]

    def apply(self, spec, **kw):
        return self("POST", "/tables/apply", {"spec": spec, **kw})

    def insert(self, table, data, parent_id=None):
        return self("POST", f"/tables/{table}/records", {"data": data, "parent_id": parent_id})

    def query(self, table, **body):
        return self("POST", f"/tables/{table}/query", body)["items"]


@pytest.fixture
def api():
    db = Database(":memory:")
    # 事件投递由测试显式调用 events.dispatch_once，避免后台任务和断言抢时序
    with TestClient(create_app(db, dispatcher=False)) as client:
        api = Api(client, db=db)
        api("POST", "/domains", {"name": "w", "label": "工作区"})
        yield api


@pytest.fixture
def task_api(api):
    api.apply(TASK_SPEC)
    return api
