import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Annotated
from urllib.parse import quote

import httpx
import typer
import yaml

from dt.db import dt_home
from dt.errors import DtError

app = typer.Typer(help="dt：给 Agent 用的动态表格", no_args_is_help=True, add_completion=False)
table_app = typer.Typer(help="模版（表结构）", no_args_is_help=True)
field_app = typer.Typer(help="字段", no_args_is_help=True)
rec_app = typer.Typer(help="记录数据", no_args_is_help=True)
event_app = typer.Typer(help="记录事件与订阅绑定", no_args_is_help=True)
inbox_app = typer.Typer(help="收件箱", no_args_is_help=True)
domain_app = typer.Typer(help="域：一组表的命名空间", no_args_is_help=True)
app.add_typer(domain_app, name="domain")
app.add_typer(table_app, name="table")
app.add_typer(field_app, name="field")
app.add_typer(rec_app, name="rec")
app.add_typer(event_app, name="event")
app.add_typer(inbox_app, name="inbox")


def port() -> int:
    return int(os.environ.get("DT_PORT", "8654"))


def emit(payload: dict):
    typer.echo(json.dumps(payload, ensure_ascii=False, indent=2))
    if not payload.get("ok"):
        raise typer.Exit(1)


def fail(e: DtError):
    emit({"ok": False, "error": e.to_dict()})


def _healthy(client: httpx.Client) -> bool:
    try:
        return client.get("/api/health", timeout=1).status_code == 200
    except httpx.TransportError:
        return False


def _start_server(client: httpx.Client):
    home = dt_home()
    home.mkdir(parents=True, exist_ok=True)
    log = open(home / "server.log", "ab")
    subprocess.Popen(
        [sys.executable, "-m", "dt", "serve", "--port", str(port())],
        stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True,
    )
    for _ in range(50):
        time.sleep(0.2)
        if _healthy(client):
            return
    raise DtError("server_unavailable", f"dt 服务没能在 127.0.0.1:{port()} 启动", f"查看日志 {home / 'server.log'}，或手动运行 dt serve")


def call(method: str, path: str, *, body=None, params=None, actor: str | None = None):
    headers = {"X-DT-Actor": actor} if actor else {}
    with httpx.Client(base_url=f"http://127.0.0.1:{port()}", headers=headers, timeout=60) as client:
        try:
            if not _healthy(client):
                _start_server(client)
            resp = client.request(method, path, json=body, params=params)
        except DtError as e:
            fail(e)
        except httpx.TransportError as e:
            fail(DtError("server_unavailable", f"连接 dt 服务失败：{e}", "运行 dt serve 后重试"))
    try:
        return resp.json()
    except ValueError:
        fail(DtError("internal", f"服务返回了非 JSON 响应（HTTP {resp.status_code}）"))


def run(method: str, path: str, *, domain: str | None = None, **kw):
    """域内命令的返回里带上 domain，agent 每次都能确认自己操作的是哪个域。"""
    resp = call(method, path, **kw)
    emit({"ok": resp.get("ok"), "domain": domain, **resp} if domain else resp)


# 域不读环境变量：agent 每次调用可能是新 shell，残留的 DT_DOMAIN 会让数据静默写进别的域
DomainOpt = Annotated[str | None, typer.Option("--domain", "-D", help="操作哪个域（必填）")]
ActorOpt = Annotated[str | None, typer.Option("--actor", "-A", envvar="DT_ACTOR", help="操作者名字，写入时必填；也可以设置 DT_ACTOR")]


def dpath(domain: str | None) -> str:
    """域内接口的前缀。没有指定域时报错，并列出已有的域。"""
    if not domain:
        names = [d["name"] for d in call("GET", "/api/domains").get("data") or []]
        hint = ("每条命令都要写 -D <域>。已有的域：" + "、".join(names) + "；用 dt domain show <域> 查看域里有哪些表") if names \
            else "还没有域，先用 dt domain apply -f <域模版> 或 dt domain create <name> 创建"
        fail(DtError("domain_required", "没有指定域", hint))
    return f"/api/d/{quote(domain, safe='')}"


def need_actor(actor: str | None) -> str:
    """写入必须表明身份，否则页面和变更历史里分不清是谁改的。"""
    if not actor:
        fail(DtError("actor_required", "写入操作需要操作者名字", "加 -A <你的名字>（例如 -A claude），或设置环境变量 DT_ACTOR"))
    return actor


def read_arg(value: str, what: str) -> str:
    """参数支持直接写、@文件、-（stdin）。"""
    if value == "-":
        return sys.stdin.read()
    if value.startswith("@"):
        try:
            return Path(value[1:]).expanduser().read_text(encoding="utf-8")
        except OSError as e:
            fail(DtError("invalid_input", f"读取 {what} 文件失败：{e}"))
    return value


def load_json(value: str, what: str):
    text = read_arg(value, what)
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        fail(DtError("invalid_json", f"{what} 不是合法 JSON：{e}", "注意 shell 引号，复杂内容可以写到文件里用 @file.json"))


class _Loader(yaml.SafeLoader):
    """只把 true/false 当布尔值。YAML 1.1 默认会把 no、yes、on、off 也转成布尔值，字段 key 写 no 就会出错。"""


_Loader.yaml_implicit_resolvers = {
    ch: [(tag, rx) for tag, rx in resolvers if tag != "tag:yaml.org,2002:bool"]
    for ch, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Loader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))


# ---------- serve ----------

@app.command()
def serve(port_: int = typer.Option(None, "--port", help="默认 $DT_PORT 或 8654")):
    """启动服务（只监听 127.0.0.1）。"""
    import uvicorn

    from dt.server import create_app

    uvicorn.run(create_app(), host="127.0.0.1", port=port_ or port(), log_level="info")


def load_spec(file: str):
    text = sys.stdin.read() if file == "-" else read_arg("@" + file, "模版")
    try:
        return yaml.load(text, Loader=_Loader)
    except yaml.YAMLError as e:
        fail(DtError("invalid_spec", f"模版不是合法 YAML/JSON：{e}"))


# ---------- domain ----------

@domain_app.command("list")
def domain_list():
    """列出所有域。"""
    run("GET", "/api/domains")


@domain_app.command("show")
def domain_show(name: str):
    """查看域里有哪些表：表名、描述、子表关系和记录数（不含字段，字段用 dt table show 看）。"""
    run("GET", f"/api/domains/{quote(name, safe='')}")


@domain_app.command("create")
def domain_create(
    name: str,
    label: str = typer.Option(None, "--label"),
    description: str = typer.Option(None, "--description", help="域的用途，agent 靠它判断该用哪个域"),
    actor: ActorOpt = None,
):
    """新建一个空的域。"""
    body = {"name": name, "label": label, "description": description}
    run("POST", "/api/domains", body={k: v for k, v in body.items() if v is not None}, actor=need_actor(actor))


@domain_app.command("apply")
def domain_apply(
    file: str = typer.Option(..., "-f", "--file", help="域模版 YAML/JSON，- 表示 stdin"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只输出变更计划"),
    force: bool = typer.Option(False, "--force", help="允许破坏性变更"),
    actor: ActorOpt = None,
):
    """按域模版创建或修改整个域（声明式，域不存在时自动创建）。"""
    spec = load_spec(file)
    run("POST", "/api/domains/apply", body={"spec": spec, "dry_run": dry_run, "force": force}, actor=actor if dry_run else need_actor(actor))


@domain_app.command("drop")
def domain_drop(name: str, force: bool = typer.Option(False, "--force", help="确认删除"), actor: ActorOpt = None):
    """删除域，连同里面所有的表和数据。"""
    run("DELETE", f"/api/domains/{quote(name, safe='')}", params={"force": force}, actor=need_actor(actor))


# ---------- table ----------

@table_app.command("apply")
def table_apply(
    domain: DomainOpt = None,
    file: str = typer.Option(..., "-f", "--file", help="YAML/JSON 模版文件，- 表示 stdin"),
    dry_run: bool = typer.Option(False, "--dry-run", help="只输出变更计划"),
    force: bool = typer.Option(False, "--force", help="允许破坏性变更"),
    actor: ActorOpt = None,
):
    """按模版创建或修改表（声明式）。"""
    spec = load_spec(file)
    run("POST", f"{dpath(domain)}/tables/apply", body={"spec": spec, "dry_run": dry_run, "force": force},
        domain=domain, actor=actor if dry_run else need_actor(actor))


@table_app.command("list")
def table_list(domain: DomainOpt = None):
    """列出域里的表（概要，同 dt domain show）。"""
    run("GET", f"{dpath(domain)}/tables", params={"brief": True}, domain=domain)


@table_app.command("show")
def table_show(name: str, domain: DomainOpt = None):
    """查看一张表的结构：字段的类型、说明、必填、选项，以及子表概要。"""
    run("GET", f"{dpath(domain)}/tables/{name}", domain=domain)


@table_app.command("drop")
def table_drop(name: str, domain: DomainOpt = None, force: bool = typer.Option(False, "--force", help="确认删除"), actor: ActorOpt = None):
    """删除表，连同子表和数据。"""
    run("DELETE", f"{dpath(domain)}/tables/{name}", params={"force": force}, domain=domain, actor=need_actor(actor))


# ---------- field ----------

@field_app.command("add")
def field_add(
    table: str,
    key: str,
    domain: DomainOpt = None,
    type_: str = typer.Option(..., "--type", help="字段类型"),
    label: str = typer.Option(None, "--label"),
    options: str = typer.Option(None, "--options", help="选项，逗号分隔"),
    required: bool = typer.Option(False, "--required"),
    unique: bool = typer.Option(False, "--unique"),
    default: str = typer.Option(None, "--default", help="默认值（JSON 或字符串）"),
    config: str = typer.Option(None, "--config", help="JSON，如 '{\"multiple\": true}'"),
    description: str = typer.Option(None, "--description", help="字段含义和填写规则，agent 读数据时靠它理解字段"),
    actor: ActorOpt = None,
):
    """给表新增一个字段。"""
    body = {"key": key, "type": type_, "label": label, "description": description, "required": required, "unique": unique}
    if options:
        body["options"] = [o.strip() for o in options.split(",") if o.strip()]
    if default is not None:
        try:
            body["default"] = json.loads(default)
        except json.JSONDecodeError:
            body["default"] = default
    if config:
        body["config"] = load_json(config, "--config")
    run("POST", f"{dpath(domain)}/tables/{table}/fields", body={k: v for k, v in body.items() if v is not None},
        domain=domain, actor=need_actor(actor))


# ---------- rec ----------

def _abs_paths(value):
    """CLI 侧把附件里的相对路径转成绝对路径（服务进程的工作目录和调用方不同）。"""
    return [os.path.abspath(os.path.expanduser(p)) for p in value]


@rec_app.command("insert")
def rec_insert(
    table: str,
    domain: DomainOpt = None,
    data: str = typer.Option(None, "--data", "-d", help="JSON / @file / -"),
    parent: int = typer.Option(None, "--parent", help="父记录 _id（子表必填，嵌套插入时不用）"),
    batch: bool = typer.Option(False, "--batch", help="批量：JSON 数组或 JSONL，默认从 stdin 读"),
    actor: ActorOpt = None,
):
    """插入记录；data 里用子表名作 key 可以一起插入子记录。"""
    if batch:
        text = read_arg(data or "-", "--data").strip()
        try:
            rows = json.loads(text) if text.startswith("[") else [json.loads(line) for line in text.splitlines() if line.strip()]
        except json.JSONDecodeError as e:
            fail(DtError("invalid_json", f"批量数据不是合法的 JSON 数组或 JSONL：{e}"))
        run("POST", f"{dpath(domain)}/tables/{table}/records", body={"rows": rows, "parent_id": parent}, domain=domain, actor=need_actor(actor))
    else:
        if data is None:
            fail(DtError("invalid_input", "缺少 --data", "例如 --data '{\"title\": \"写设计\"}'"))
        run("POST", f"{dpath(domain)}/tables/{table}/records", body={"data": load_json(data, "--data"), "parent_id": parent},
            domain=domain, actor=need_actor(actor))


@rec_app.command("get")
def rec_get(table: str, record_id: int, domain: DomainOpt = None, include: str = typer.Option(None, "--include", help="子表路径，如 task_log,task_log.x")):
    """按 _id 读取一条记录。"""
    run("GET", f"{dpath(domain)}/tables/{table}/records/{record_id}", params={"include": include} if include else None, domain=domain)


@rec_app.command("query")
def rec_query(
    table: str,
    domain: DomainOpt = None,
    where: str = typer.Option(None, "--where", "-w", help="查询条件 JSON / @file / -"),
    sort: str = typer.Option(None, "--sort", help="如 -_updated_at,title"),
    limit: int = typer.Option(100, "--limit"),
    offset: int = typer.Option(0, "--offset"),
    include: str = typer.Option(None, "--include"),
    parent: int = typer.Option(None, "--parent", help="只查某个父记录下的子记录"),
    fmt: str = typer.Option("json", "--format", help="json 或 table"),
):
    """按条件查询记录。"""
    body = {"where": load_json(where, "--where") if where else None, "sort": sort, "limit": limit,
            "offset": offset, "include": include, "parent_id": parent}
    resp = call("POST", f"{dpath(domain)}/tables/{table}/query", body=body)
    if fmt == "table" and resp.get("ok"):
        typer.echo(render_table(resp["data"]["items"]))
        typer.echo(f"({len(resp['data']['items'])} / {resp['data']['total']}，域 {domain})")
        return
    emit({"ok": resp.get("ok"), "domain": domain, **resp})


@rec_app.command("update")
def rec_update(
    table: str,
    record_id: int,
    domain: DomainOpt = None,
    set_: str = typer.Option(..., "--set", "-s", help="要修改的字段 JSON / @file / -"),
    if_version: int = typer.Option(None, "--if-version", help="乐观锁：版本不一致时拒绝"),
    actor: ActorOpt = None,
):
    """修改记录的部分字段；字段设为 null 表示清空。"""
    run("PATCH", f"{dpath(domain)}/tables/{table}/records/{record_id}", body={"set": load_json(set_, "--set"), "if_version": if_version},
        domain=domain, actor=need_actor(actor))


@rec_app.command("attach")
def rec_attach(table: str, record_id: int, field: str, paths: list[str], domain: DomainOpt = None, actor: ActorOpt = None):
    """给附件字段追加文件或目录（相对路径会转成绝对路径）。"""
    run("POST", f"{dpath(domain)}/tables/{table}/records/{record_id}/attach", body={"field": field, "paths": _abs_paths(paths)},
        domain=domain, actor=need_actor(actor))


@rec_app.command("delete")
def rec_delete(table: str, record_id: int, domain: DomainOpt = None, actor: ActorOpt = None):
    """删除记录，子记录按 on_delete 规则处理。"""
    run("DELETE", f"{dpath(domain)}/tables/{table}/records/{record_id}", domain=domain, actor=need_actor(actor))


@app.command()
def history(
    domain: DomainOpt = None,
    table: str = typer.Option(None, "--table"),
    record_id: int = typer.Option(None, "--id"),
    since: int = typer.Option(None, "--since", help="只看 seq 大于它的变更"),
    limit: int = typer.Option(50, "--limit"),
):
    """查看变更历史。"""
    params = {"table": table, "record_id": record_id, "since": since, "limit": limit}
    run("GET", f"{dpath(domain)}/changes", params={k: v for k, v in params.items() if v is not None}, domain=domain)


# ---------- event ----------

def _event_params(table, field, op, record_id, since, limit) -> dict:
    params = {"table": table, "field": field, "op": op, "record_id": record_id, "since": since, "limit": limit}
    return {k: v for k, v in params.items() if v is not None}


@event_app.command("list")
def event_list(
    domain: DomainOpt = None,
    table: str = typer.Option(None, "--table", help="只看某张表"),
    field: str = typer.Option(None, "--field", help="只看实际变化了该字段的事件"),
    op: str = typer.Option(None, "--op", help="insert,update,delete，逗号分隔；默认全部"),
    record_id: int = typer.Option(None, "--id", help="只看某条记录"),
    since: int = typer.Option(None, "--since", help="只看 seq 大于它的事件"),
    limit: int = typer.Option(50, "--limit"),
):
    """查看记录事件（字段级 before/after）。"""
    run("GET", f"{dpath(domain)}/events", params=_event_params(table, field, op, record_id, since, limit), domain=domain)


@event_app.command("watch")
def event_watch(
    domain: DomainOpt = None,
    table: str = typer.Option(None, "--table"),
    field: str = typer.Option(None, "--field", help="只看实际变化了该字段的事件"),
    op: str = typer.Option(None, "--op", help="insert,update,delete，逗号分隔；默认全部"),
    since: int = typer.Option(None, "--since", help="从这个 seq 之后开始；不写则只推新事件"),
    interval: float = typer.Option(0.5, "--interval", help="轮询间隔秒数"),
    timeout: float = typer.Option(None, "--timeout", help="持续多少秒后退出；0 表示只拉一次"),
    limit: int = typer.Option(100, "--limit", help="每次最多拉多少条，不会漏"),
):
    """持续输出记录事件，每行一个 JSON；按游标续拉，适合 agent 监听。"""
    path = f"{dpath(domain)}/events"
    params = _event_params(table, field, op, None, None, None)
    if since is None:
        resp = call("GET", path, params={**params, "limit": 0})
        if not resp.get("ok"):
            emit(resp)
        cursor = resp["data"]["seq"]
    else:
        cursor = since
    deadline = None if timeout is None else time.time() + timeout
    try:
        while True:
            resp = call("GET", path, params={**params, "since": cursor, "limit": limit})
            if not resp.get("ok"):
                emit(resp)
            for event in resp["data"]["items"]:
                typer.echo(json.dumps(event, ensure_ascii=False))
                sys.stdout.flush()
            cursor = resp["data"]["seq"]
            if deadline is not None and time.time() >= deadline:
                break
            time.sleep(max(0.05, interval))
    except KeyboardInterrupt:
        pass


@event_app.command("bind")
def event_bind(
    name: str,
    domain: DomainOpt = None,
    on: str = typer.Option("insert,update,delete", "--on", help="订阅哪些操作，逗号分隔"),
    table: str = typer.Option(None, "--table", help="不写表示整个域"),
    field: str = typer.Option(None, "--field", help="只看该字段实际变化；需要 --table"),
    where: str = typer.Option(None, "--where", help="变化后的值满足的条件 JSON / @file / -"),
    where_before: str = typer.Option(None, "--where-before", help="变化前的值满足的条件 JSON / @file / -"),
    action: str = typer.Option(..., "--action", help="webhook / command / write / inbox"),
    config: str = typer.Option(..., "--config", help="动作配置 JSON / @file / -"),
    disabled: bool = typer.Option(False, "--disabled", help="先建好但不启用"),
    actor: ActorOpt = None,
):
    """绑定记录事件。

    webhook: --config '{"url":"http://127.0.0.1:9000/hook"}'
    command: --config '{"cmd":"cat >> /tmp/dt-events.jsonl"}'
    write:   --config '{"table":"task_log","parent_id":"${event.record_id}","data":{"content":"状态变更"}}'
    inbox:   --config '{"title":"${record.title} 完成了","body":"${fields.status.before} → ${fields.status.after}"}'
    """
    body = {
        "name": name,
        "ops": [x.strip() for x in on.split(",") if x.strip()],
        "table": table,
        "field": field,
        "where": load_json(where, "--where") if where else None,
        "where_before": load_json(where_before, "--where-before") if where_before else None,
        "action": action,
        "config": load_json(config, "--config"),
        "enabled": not disabled,
    }
    run("POST", f"{dpath(domain)}/bindings", body={k: v for k, v in body.items() if v is not None},
        domain=domain, actor=need_actor(actor))


@event_app.command("binds")
def event_binds(domain: DomainOpt = None):
    """列出当前域的事件绑定。"""
    run("GET", f"{dpath(domain)}/bindings", domain=domain)


@event_app.command("update")
def event_update(
    name: str,
    domain: DomainOpt = None,
    on: str = typer.Option(None, "--on", help="订阅哪些操作，逗号分隔"),
    table: str = typer.Option(None, "--table", help="表名；传空字符串表示改成整个域"),
    field: str = typer.Option(None, "--field", help="字段；传空字符串表示任意字段"),
    where: str = typer.Option(None, "--where", help="变化后的条件；传空字符串表示清除"),
    where_before: str = typer.Option(None, "--where-before", help="变化前的条件；传空字符串表示清除"),
    action: str = typer.Option(None, "--action", help="webhook / command / write / inbox"),
    config: str = typer.Option(None, "--config", help="动作配置 JSON / @file / -"),
    enabled: bool | None = typer.Option(None, "--enabled/--disabled", help="启用或停用"),
    actor: ActorOpt = None,
):
    """修改已有绑定；只传要改的项。"""
    body: dict = {}
    if on is not None:
        body["ops"] = [x.strip() for x in on.split(",") if x.strip()]
    if table is not None:
        body["table"] = table or None
    if field is not None:
        body["field"] = field or None
    if where is not None:
        body["where"] = load_json(where, "--where") if where else None
    if where_before is not None:
        body["where_before"] = load_json(where_before, "--where-before") if where_before else None
    if action is not None:
        body["action"] = action
    if config is not None:
        body["config"] = load_json(config, "--config")
    if enabled is not None:
        body["enabled"] = enabled
    if not body:
        fail(DtError("invalid_input", "没有要修改的字段", "至少传一个 --on / --table / --field / --where / --action / --config / --enabled / --disabled"))
    run("PATCH", f"{dpath(domain)}/bindings/{quote(name, safe='')}", body=body, domain=domain, actor=need_actor(actor))


@event_app.command("unbind")
def event_unbind(name: str, domain: DomainOpt = None, actor: ActorOpt = None):
    """删除一个事件绑定。"""
    run("DELETE", f"{dpath(domain)}/bindings/{quote(name, safe='')}", domain=domain, actor=need_actor(actor))


@event_app.command("deliveries")
def event_deliveries(
    name: str,
    domain: DomainOpt = None,
    status: str = typer.Option(None, "--status", help="pending / sent / failed"),
    limit: int = typer.Option(100, "--limit"),
):
    """查看某个绑定的投递记录。"""
    run("GET", f"{dpath(domain)}/bindings/{quote(name, safe='')}/deliveries",
        params={k: v for k, v in {"status": status, "limit": limit}.items() if v is not None}, domain=domain)


@event_app.command("retry")
def event_retry(name: str, domain: DomainOpt = None, actor: ActorOpt = None):
    """把某个绑定失败的投递重新排队。"""
    run("POST", f"{dpath(domain)}/bindings/{quote(name, safe='')}/retry", domain=domain, actor=need_actor(actor))


# ---------- inbox ----------

@inbox_app.command("list")
def inbox_list(
    domain: DomainOpt = None,
    status: str = typer.Option(None, "--status", help="unread / read；不写表示全部"),
    limit: int = typer.Option(50, "--limit"),
    offset: int = typer.Option(0, "--offset"),
):
    """查看收件箱消息。"""
    run("GET", f"{dpath(domain)}/inbox",
        params={k: v for k, v in {"status": status, "limit": limit, "offset": offset}.items() if v is not None},
        domain=domain)


@inbox_app.command("read")
def inbox_read(message_id: int, domain: DomainOpt = None, actor: ActorOpt = None):
    """把一条消息标为已读。"""
    run("PATCH", f"{dpath(domain)}/inbox/{message_id}", body={"status": "read"},
        domain=domain, actor=need_actor(actor))


@inbox_app.command("unread")
def inbox_unread(message_id: int, domain: DomainOpt = None, actor: ActorOpt = None):
    """把一条消息标为未读。"""
    run("PATCH", f"{dpath(domain)}/inbox/{message_id}", body={"status": "unread"},
        domain=domain, actor=need_actor(actor))


@inbox_app.command("read-all")
def inbox_read_all(domain: DomainOpt = None, actor: ActorOpt = None):
    """把当前域所有未读消息标为已读。"""
    run("POST", f"{dpath(domain)}/inbox/read-all", domain=domain, actor=need_actor(actor))


@inbox_app.command("delete")
def inbox_delete(message_id: int, domain: DomainOpt = None, actor: ActorOpt = None):
    """删除一条收件箱消息。"""
    run("DELETE", f"{dpath(domain)}/inbox/{message_id}", domain=domain, actor=need_actor(actor))


# ---------- 表格输出 ----------

def _width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        value = value.get("name") or value.get("path") or json.dumps(value, ensure_ascii=False)
    elif isinstance(value, list):
        value = ", ".join(_cell(v) for v in value)
    text = str(value).replace("\n", " ")
    out = ""
    for c in text:
        if _width(out + c) > 30:
            return out + "…"
        out += c
    return out


def render_table(items: list[dict]) -> str:
    if not items:
        return "(无记录)"
    hidden = {"_parent_id", "_version", "_created_at", "_created_by", "_updated_by"}
    cols = [k for k in items[0] if k not in hidden and not _is_child(items[0][k])]
    rows = [[_cell(r.get(c)) for c in cols] for r in items]
    widths = [max(_width(c), *(_width(r[i]) for r in rows)) for i, c in enumerate(cols)]

    def line(cells):
        return "  ".join(c + " " * (w - _width(c)) for c, w in zip(cells, widths)).rstrip()

    return "\n".join([line(cols), line(["-" * w for w in widths]), *map(line, rows)])


def _is_child(value) -> bool:
    """--include 带出的子表数据（含 _id 的对象或对象数组）不在表格里展示。"""
    items = value if isinstance(value, list) else [value]
    return any(isinstance(v, dict) and "_id" in v for v in items)


def main():
    app()
