import asyncio
import contextlib
from contextlib import contextmanager
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect

from dt import domains, events, files, graph, inbox, records, schema
from dt.db import Database, dt_home
from dt.errors import DtError
from dt.model import bind_domain, get_domain, get_table, list_tables


class ApplyBody(BaseModel):
    spec: dict
    dry_run: bool = False
    force: bool = False


class InsertBody(BaseModel):
    data: dict | None = None
    rows: list | None = None
    parent_id: int | None = None


class QueryBody(BaseModel):
    where: dict | None = None
    sort: str | None = None
    limit: int = 100
    offset: int = 0
    include: str | None = None
    parent_id: int | None = None


class UpdateBody(BaseModel):
    set: dict
    if_version: int | None = None


class AttachBody(BaseModel):
    field: str
    paths: list[str]


class StatusBody(BaseModel):
    record_ids: list[int]


def ok(data):
    return {"ok": True, "data": data}


STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = ["127.0.0.1", "localhost", "testserver"]


class Hub:
    """写事务在线程池里提交，提交后唤醒所有 WebSocket 连接去读新的 changes。"""

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.waiters: set[asyncio.Event] = set()

    def notify(self):
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._wake)

    def _wake(self):
        for event in self.waiters:
            event.set()


def create_app(db: Database | None = None, *, dispatcher: bool = True) -> FastAPI:
    db = db or Database(dt_home() / "dt.db")
    app = FastAPI(title="dt")
    app.state.db = db
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOCAL_HOSTS)  # 防 DNS rebinding
    hub = Hub()
    db.listeners.append(hub.notify)

    @app.exception_handler(DtError)
    async def dt_error(_, e: DtError):
        return JSONResponse({"ok": False, "error": e.to_dict()}, status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_, e: RequestValidationError):
        msg = "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors())
        return JSONResponse({"ok": False, "error": {"code": "invalid_request", "message": msg, "hint": None}}, status_code=422)

    @app.exception_handler(Exception)
    async def any_error(_, e: Exception):
        return JSONResponse({"ok": False, "error": {"code": "internal", "message": repr(e), "hint": None}}, status_code=500)

    def actor(request: Request) -> str:
        return request.headers.get("x-dt-actor") or "web"

    @app.get("/api/health")
    def health():
        return ok({"pid": os.getpid()})

    @contextmanager
    def write(request: Request, domain: str):
        with db.tx(actor(request)) as tx:
            bind_domain(tx, domain)
            yield tx

    def table_of(conn, domain: str, name: str):
        return get_table(conn, get_domain(conn, domain)["id"], name)

    # ---------- 域 ----------

    @app.get("/api/domains")
    def domain_list():
        with db.read() as conn:
            return ok(domains.list_domains(conn))

    @app.post("/api/domains")
    def domain_create(body: dict, request: Request):
        return ok(domains.create(db, body, actor=actor(request)))

    @app.post("/api/domains/apply")
    def domain_apply(body: ApplyBody, request: Request):
        return ok(domains.apply(db, body.spec, dry_run=body.dry_run, force=body.force, actor=actor(request)))

    @app.get("/api/domains/{domain}")
    def domain_show(domain: str):
        with db.read() as conn:
            return ok(domains.show(conn, domain))

    @app.delete("/api/domains/{domain}")
    def domain_drop(domain: str, request: Request, force: bool = False):
        return ok(domains.drop(db, domain, force=force, actor=actor(request)))

    # ---------- 域内的表和记录 ----------

    D = "/api/d/{domain}"

    @app.get(D + "/tables")
    def tables(domain: str, brief: bool = False):
        """brief=true 只返回概要（名字、描述、子表），不带字段。"""
        with db.read() as conn:
            did = get_domain(conn, domain)["id"]
            if brief:
                return ok([schema.table_summary(conn, t) for t in list_tables(conn, did) if t.parent is None])
            return ok([schema.table_to_dict(conn, t, tree=False) for t in list_tables(conn, did)])

    @app.get(D + "/tables/{name}")
    def show(domain: str, name: str):
        with db.read() as conn:
            return ok(schema.table_to_dict(conn, table_of(conn, domain, name)))

    @app.post(D + "/tables/apply")
    def apply(domain: str, body: ApplyBody, request: Request):
        return ok(schema.apply(db, domain, body.spec, dry_run=body.dry_run, force=body.force, actor=actor(request)))

    @app.delete(D + "/tables/{name}")
    def drop(domain: str, name: str, request: Request, force: bool = False):
        return ok(schema.drop_table(db, domain, name, force=force, actor=actor(request)))

    @app.post(D + "/tables/{name}/fields")
    def add_field(domain: str, name: str, body: dict, request: Request):
        return ok(schema.add_field(db, domain, name, body, actor=actor(request)))

    @app.post(D + "/tables/{name}/records")
    def insert(domain: str, name: str, body: InsertBody, request: Request):
        if (body.data is None) == (body.rows is None):
            raise DtError("invalid_value", "data 和 rows 必须二选一")
        with write(request, domain) as tx:
            table = get_table(tx.conn, tx.domain_id, name)
            if body.rows is not None:
                return ok(records.insert_many(tx, table, body.rows, body.parent_id))
            return ok(records.insert(tx, table, body.data, body.parent_id))

    @app.get(D + "/tables/{name}/records/{record_id}")
    def get(domain: str, name: str, record_id: int, include: str | None = None):
        with db.read() as conn:
            return ok(records.get(conn, table_of(conn, domain, name), record_id, include))

    @app.post(D + "/tables/{name}/query")
    def query(domain: str, name: str, body: QueryBody):
        with db.read() as conn:
            return ok(records.query(conn, table_of(conn, domain, name), **body.model_dump()))

    @app.patch(D + "/tables/{name}/records/{record_id}")
    def update(domain: str, name: str, record_id: int, body: UpdateBody, request: Request):
        with write(request, domain) as tx:
            return ok(records.update(tx, get_table(tx.conn, tx.domain_id, name), record_id, body.set, body.if_version))

    @app.post(D + "/tables/{name}/records/{record_id}/attach")
    def attach(domain: str, name: str, record_id: int, body: AttachBody, request: Request):
        with write(request, domain) as tx:
            return ok(records.attach(tx, get_table(tx.conn, tx.domain_id, name), record_id, body.field, body.paths))

    @app.delete(D + "/tables/{name}/records/{record_id}")
    def delete(domain: str, name: str, record_id: int, request: Request):
        with write(request, domain) as tx:
            return ok(records.delete(tx, get_table(tx.conn, tx.domain_id, name), record_id))

    @app.get(D + "/changes")
    def changes(domain: str, table: str | None = None, record_id: int | None = None, since: int | None = None, limit: int = 100):
        with db.read() as conn:
            get_domain(conn, domain)
            return ok(records.list_changes(conn, domain, table, record_id, since, min(max(limit, 1), 1000)))

    @app.get(D + "/events")
    def list_events(domain: str, op: str | None = None, table: str | None = None, field: str | None = None,
                    record_id: int | None = None, since: int | None = None, limit: int = 100):
        """记录事件流：只包含 insert / update / delete，带字段级 fields。"""
        with db.read() as conn:
            get_domain(conn, domain)
            items, cursor = events.list_events(
                conn, domain, ops=op, table=table, field=field, record_id=record_id, since=since, limit=limit
            )
        return ok({"items": items, "seq": cursor})

    @app.get(D + "/graph")
    def graph_view(domain: str, tables: str | None = None, limit: int = 3000):
        """知识图谱：tables 是逗号分隔的表名，省略表示整个域。"""
        with db.read() as conn:
            did = get_domain(conn, domain)["id"]
            names = None if tables is None else [x for x in tables.split(",") if x]
            return ok(graph.build(conn, domain, did, names, min(max(limit, 0), 10000)))

    @app.get(D + "/inbox")
    def list_inbox(domain: str, status: str | None = None, limit: int = 100, offset: int = 0):
        with db.read() as conn:
            return ok(inbox.list_messages(conn, domain, status, limit, offset))

    @app.post(D + "/inbox/read-all")
    def inbox_read_all(domain: str, request: Request):
        return ok(inbox.read_all(db, domain, actor=actor(request)))

    @app.patch(D + "/inbox/{message_id}")
    def inbox_mark(domain: str, message_id: int, body: dict, request: Request):
        status = body.get("status")
        if status not in ("read", "unread"):
            raise DtError("invalid_value", "status 只能是 read 或 unread")
        return ok(inbox.mark_read(db, domain, message_id, read=status == "read", actor=actor(request)))

    @app.delete(D + "/inbox/{message_id}")
    def inbox_delete(domain: str, message_id: int, request: Request):
        return ok(inbox.delete_message(db, domain, message_id, actor=actor(request)))

    @app.get(D + "/bindings")
    def bindings(domain: str):
        with db.read() as conn:
            return ok(events.list_bindings(conn, domain))

    @app.post(D + "/bindings")
    def create_binding(domain: str, body: dict, request: Request):
        return ok(events.create_binding(db, domain, body, actor=actor(request)))

    @app.get(D + "/bindings/{name}/deliveries")
    def deliveries(domain: str, name: str, status: str | None = None, limit: int = 100):
        with db.read() as conn:
            return ok(events.list_deliveries(conn, domain, name, status, limit))

    @app.post(D + "/bindings/{name}/retry")
    def retry_binding(domain: str, name: str, request: Request):
        return ok(events.retry_binding(db, domain, name, actor=actor(request)))

    @app.patch(D + "/bindings/{name}")
    def update_binding(domain: str, name: str, body: dict, request: Request):
        return ok(events.update_binding(db, domain, name, body, actor=actor(request)))

    @app.delete(D + "/bindings/{name}")
    def delete_binding(domain: str, name: str, request: Request):
        return ok(events.delete_binding(db, domain, name, actor=actor(request)))

    @app.websocket("/api/ws/events")
    async def ws_events(websocket: WebSocket, since: int | None = None, domain: str | None = None,
                        op: str | None = None, table: str | None = None, field: str | None = None):
        origin = websocket.headers.get("origin")
        if origin and urlparse(origin).hostname not in LOCAL_HOSTS:
            await websocket.close(code=1008)
            return
        requested = set(events.parse_ops(op))
        await websocket.accept()
        hub.loop = asyncio.get_running_loop()
        waiter = asyncio.Event()
        hub.waiters.add(waiter)

        def latest() -> int:
            with db.read() as conn:
                return conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]

        def fetch(seq: int):
            with db.read() as conn:
                return records.list_changes(conn, domain, since=seq, limit=500, domain_ops=False)

        async def until_closed():
            while (await websocket.receive())["type"] != "websocket.disconnect":
                pass

        closed = asyncio.ensure_future(until_closed())
        try:
            seq = since if since is not None else await asyncio.to_thread(latest)
            await websocket.send_json({"type": "hello", "seq": seq})
            while not closed.done():
                waiter.clear()
                batch = await asyncio.to_thread(fetch, seq)
                for change in batch:
                    seq = change["seq"]
                    if change["op"] not in requested:
                        continue
                    if table and change["table_name"] != table:
                        continue
                    event = events.event_from_change(change)
                    if field and field not in event["fields"]:
                        continue
                    await websocket.send_json({"type": "event", "event": event})
                if len(batch) == 500:
                    continue
                pending = asyncio.ensure_future(waiter.wait())
                await asyncio.wait({pending, closed}, return_when=asyncio.FIRST_COMPLETED)
                pending.cancel()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            hub.waiters.discard(waiter)
            closed.cancel()

    @app.websocket("/api/ws")
    async def ws(websocket: WebSocket, since: int | None = None, domain: str | None = None):
        origin = websocket.headers.get("origin")
        if origin and urlparse(origin).hostname not in LOCAL_HOSTS:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        hub.loop = asyncio.get_running_loop()
        event = asyncio.Event()
        hub.waiters.add(event)

        def latest() -> int:
            with db.read() as conn:
                return conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]

        def fetch(seq: int):
            with db.read() as conn:
                return records.list_changes(conn, domain, since=seq, limit=500, domain_ops=True)

        async def until_closed():
            while (await websocket.receive())["type"] != "websocket.disconnect":
                pass

        closed = asyncio.ensure_future(until_closed())
        try:
            seq = since if since is not None else await asyncio.to_thread(latest)
            await websocket.send_json({"type": "hello", "seq": seq})
            while not closed.done():
                event.clear()
                batch = await asyncio.to_thread(fetch, seq)
                for change in batch:
                    await websocket.send_json({"type": "change", "change": change})
                    seq = change["seq"]
                if len(batch) == 500:
                    continue
                waiter = asyncio.ensure_future(event.wait())
                await asyncio.wait({waiter, closed}, return_when=asyncio.FIRST_COMPLETED)
                waiter.cancel()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            hub.waiters.discard(event)
            closed.cancel()

    @app.post("/api/files/status")
    def file_status(body: StatusBody):
        with db.read() as conn:
            return ok(files.statuses(conn, body.record_ids))

    @app.get("/api/files/{record_id}/{field}/{idx}/tree")
    def file_tree(record_id: int, field: str, idx: int):
        with db.read() as conn:
            item = files.get_item(conn, record_id, field, idx)
        return ok(files.tree(item))

    @app.get("/api/files/{record_id}/{field}/{idx}")
    def file_read(record_id: int, field: str, idx: int, sub: str | None = None):
        with db.read() as conn:
            item = files.get_item(conn, record_id, field, idx)
        path = files.resolve(item, sub)
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}
        if mime != "application/pdf":
            # agent 产出的 HTML/SVG 不能以本站身份执行脚本；PDF 加 sandbox 后浏览器不渲染
            headers["Content-Security-Policy"] = "sandbox"
        return FileResponse(path, media_type=mime, headers=headers, content_disposition_type="inline", filename=os.path.basename(path))

    if (STATIC / "index.html").exists():
        app.mount("/", StaticFiles(directory=STATIC, html=True), name="web")
    else:
        @app.get("/")
        def no_web():
            return ok({"message": "前端还没构建", "hint": "运行 cd web && npm install && npm run build，然后重启 dt serve"})

    if dispatcher:
        @app.on_event("startup")
        async def start_dispatcher():
            app.state.dispatcher = asyncio.create_task(events.dispatcher_loop(db))

        @app.on_event("shutdown")
        async def stop_dispatcher():
            task = getattr(app.state, "dispatcher", None)
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    return app
