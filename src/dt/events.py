"""记录事件：字段级变更、事件游标、订阅绑定与投递。

事件直接读取 dt_changes 里的 insert / update / delete，字段差异按 before/after 计算，
不额外存一份事件表。绑定和投递各自落在 dt_bindings、dt_deliveries。
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from dt import records
from dt.db import Tx, dumps, now
from dt.errors import DtError, not_found
from dt.model import bind_domain, get_domain, get_table

log = logging.getLogger("dt.events")

RECORD_OPS = ("insert", "update", "delete")
ACTIONS = ("webhook", "command", "write", "inbox")
WHERE_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "is_null"}
SYSTEM_FIELDS = {
    "_id", "_parent_id", "_version", "_created_at", "_updated_at", "_created_by", "_updated_by",
}
BINDING_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
# 投递失败后的退避秒数；超过次数标 failed，可用 dt event retry 重试
BACKOFF = (1, 5, 30, 120, 600, 1800, 3600)
# 一条投递最多合并多少条事件；同一事务里同一绑定的事件会合并成一条投递
MAX_EVENTS_PER_DELIVERY = 1000
# 一次动作最多携带多少条事件；避免单个 webhook / 命令 payload 无限大
MAX_EVENTS_PER_ACTION = 4000
DEFAULT_BATCH = 20
DEFAULT_MAX_PENDING = 50000
SENT_RETENTION_DAYS = 7
FAILED_RETENTION_DAYS = 30
_cap_warned: dict[int, float] = {}


def _warn_cap(binding: dict, max_pending: int):
    now = time.monotonic()
    if now - _cap_warned.get(binding["id"], 0) > 60:
        _cap_warned[binding["id"]] = now
        print(f"dt: 绑定 {binding['name']} 待投递已达 {max_pending} 条，跳过后续事件", file=sys.stderr)


def _bad(message: str, hint: str | None = None) -> DtError:
    return DtError("invalid_binding", message, hint)


# ---------- 事件 ----------

def diff_fields(before: dict | None, after: dict | None) -> dict:
    """只返回用户字段的实际变化；系统字段（_id、_updated_at 等）不算。"""
    before, after = before or {}, after or {}
    out = {}
    for key in sorted(set(before) | set(after)):
        if key.startswith("_"):
            continue
        old, new = before.get(key), after.get(key)
        if old != new:
            out[key] = {"before": old, "after": new}
    return out


def event_from_change(change: dict) -> dict:
    before, after = change.get("before"), change.get("after")
    fields = change.get("fields")
    if isinstance(fields, str):
        fields = json.loads(fields)
    if fields is None:
        fields = diff_fields(before, after)
    return {
        "seq": change["seq"],
        "op": change["op"],
        "domain": change.get("domain"),
        "table": change["table_name"],
        "record_id": change.get("record_id"),
        "actor": change.get("actor"),
        "ts": change["ts"],
        "fields": fields,
        "record": after if after is not None else before,
    }


def _change_row(row) -> dict:
    return {
        **dict(row),
        "before": json.loads(row["before"]) if row["before"] else None,
        "after": json.loads(row["after"]) if row["after"] else None,
        "fields": json.loads(row["fields"]) if row["fields"] else None,
    }


def parse_ops(value) -> list[str]:
    if value is None or value == "":
        return list(RECORD_OPS)
    items = value if isinstance(value, (list, tuple)) else str(value).split(",")
    ops = [str(x).strip() for x in items if str(x).strip()]
    unknown = set(ops) - set(RECORD_OPS)
    if unknown:
        raise _bad(f"未知的事件类型 {sorted(unknown)}", "可用：" + "、".join(RECORD_OPS))
    return list(dict.fromkeys(ops))


def list_events(conn, domain=None, ops=None, table=None, field=None, record_id=None, since=None, limit=100):
    """返回 (事件列表, 游标)。字段筛选走 dt_change_fields 索引，不会反向扫整张变更表。"""
    ops = parse_ops(ops)
    marks = ",".join("?" * len(ops))
    where = [f"c.op IN ({marks})"]
    params: list = list(ops)
    if domain is not None:
        where.append("c.domain = ?")
        params.append(domain)
    if table:
        where.append("c.table_name = ?")
        params.append(table)
    if record_id is not None:
        where.append("c.record_id = ?")
        params.append(record_id)
    clause = " AND ".join(where)
    limit = max(0, min(int(limit), 1000))

    if since is None:
        cursor = conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0]
        if limit == 0:
            return [], cursor
        if field:
            rows = conn.execute(
                f"SELECT c.* FROM dt_change_fields f JOIN dt_changes c ON c.seq = f.seq"
                f" WHERE f.field = ? AND {clause} ORDER BY f.seq DESC LIMIT ?",
                (field, *params, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                f"SELECT c.* FROM dt_changes c WHERE {clause} ORDER BY c.seq DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        return [event_from_change(_change_row(r)) for r in reversed(rows)], cursor

    if limit == 0:
        return [], since
    if field:
        rows = conn.execute(
            f"SELECT c.* FROM dt_change_fields f JOIN dt_changes c ON c.seq = f.seq"
            f" WHERE f.field = ? AND {clause} AND c.seq > ? ORDER BY c.seq LIMIT ?",
            (field, *params, since, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT c.* FROM dt_changes c WHERE {clause} AND c.seq > ? ORDER BY c.seq LIMIT ?",
            (*params, since, limit),
        ).fetchall()
    items = [event_from_change(_change_row(r)) for r in rows]
    if len(items) < limit:
        # 一批没取满，说明已经扫到末尾；游标直接推到当前最大 seq，避免下次重复扫描
        cursor = max(since, conn.execute("SELECT COALESCE(MAX(seq), 0) FROM dt_changes").fetchone()[0])
    else:
        cursor = items[-1]["seq"]
    return items, cursor


# ---------- where 条件 ----------

def _check_where(node, what: str, table=None):
    if not isinstance(node, dict):
        raise _bad(f"{what} 必须是 JSON 对象")
    for key, cond in node.items():
        if key in ("$and", "$or"):
            if not isinstance(cond, list) or not cond:
                raise _bad(f"{what} 的 {key} 需要一个非空数组")
            for item in cond:
                _check_where(item, what, table)
            continue
        if key.startswith("$"):
            raise _bad(f"{what} 里有未知的组合运算符 {key}", "只支持 $and 和 $or")
        if table is not None and key not in SYSTEM_FIELDS and table.field(key) is None:
            raise _bad(f"{what} 里的字段 {key} 不存在", "可用字段：" + "、".join(f.key for f in table.active_fields))
        if isinstance(cond, dict):
            unknown = set(cond) - WHERE_OPS
            if unknown or not cond:
                raise _bad(f"{what} 的字段 {key} 有未知运算符 {sorted(unknown)}", "运算符：" + " ".join(sorted(WHERE_OPS)))


def _cmp(value, target, op: str) -> bool:
    try:
        return {
            "gt": value > target, "gte": value >= target,
            "lt": value < target, "lte": value <= target,
        }[op]
    except TypeError:
        try:
            a, b = float(value), float(target)
            return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
        except (TypeError, ValueError):
            return False


def _match_op(value, op: str, target) -> bool:
    if op == "is_null":
        return (value is None) == bool(target)
    if isinstance(value, list):
        members = [v.get("path") if isinstance(v, dict) and "path" in v else v for v in value]
        values = target if isinstance(target, list) else [target]
        if op in ("eq", "contains"):
            return all(v in members for v in values)
        if op == "ne":
            return not all(v in members for v in values)
        if op == "in":
            return any(v in members for v in values)
        if op == "nin":
            return not any(v in members for v in values)
        return False
    if op == "eq":
        return value == target
    if op == "ne":
        return value != target
    if op == "in":
        return value in (target or [])
    if op == "nin":
        return value not in (target or [])
    if op == "contains":
        return value is not None and str(target).lower() in str(value).lower()
    if op in ("gt", "gte", "lt", "lte"):
        return value is not None and target is not None and _cmp(value, target, op)
    return False


def match_where(record: dict, where: dict | None) -> bool:
    if not where:
        return True
    for key, cond in where.items():
        if key == "$and":
            if not all(match_where(record, c) for c in cond):
                return False
            continue
        if key == "$or":
            if not any(match_where(record, c) for c in cond):
                return False
            continue
        value = record.get(key)
        ops = cond if isinstance(cond, dict) else {"eq": cond}
        for op, target in ops.items():
            if not _match_op(value, op, target):
                return False
    return True


# ---------- 绑定 ----------

def binding_from_row(row) -> dict:
    out = dict(row)
    out["ops"] = json.loads(out["ops"])
    out["where"] = json.loads(out["where_expr"]) if out["where_expr"] else None
    out["where_before"] = json.loads(out["where_before"]) if out["where_before"] else None
    out["config"] = json.loads(out["config"])
    out["enabled"] = bool(out["enabled"])
    out.pop("where_expr", None)
    return out


def list_bindings(conn, domain: str) -> list[dict]:
    get_domain(conn, domain)
    return [binding_from_row(r) for r in conn.execute(
        "SELECT * FROM dt_bindings WHERE domain = ? ORDER BY name", (domain,)
    )]


def get_binding(conn, domain: str, name: str) -> dict:
    row = conn.execute("SELECT * FROM dt_bindings WHERE domain = ? AND name = ?", (domain, name)).fetchone()
    if row is None:
        raise not_found(f"绑定 {name}", "用 dt event binds 查看当前域已有的绑定")
    return binding_from_row(row)


def _validate_config(conn, did: int, domain: str, action: str, config) -> dict:
    if not isinstance(config, dict):
        raise _bad("config 必须是 JSON 对象", "webhook: {url}；command: {cmd}；write: {table, mode, data}；inbox: {title?, body?}")
    for key, default, upper in (("batch", DEFAULT_BATCH, 1000), ("max_pending", DEFAULT_MAX_PENDING, 1_000_000)):
        value = config.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= upper:
            raise _bad(f"config 的 {key} 要是 1 到 {upper} 的整数")
        config = {**config, key: value}
    if action == "webhook":
        url = config.get("url")
        if not isinstance(url, str) or urlparse(url).scheme not in ("http", "https") or not urlparse(url).netloc:
            raise _bad("webhook 需要一个 http(s) URL", '例如 {"url": "http://127.0.0.1:9000/hook"}')
        if config.get("headers") is not None:
            headers = config["headers"]
            if not isinstance(headers, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
                raise _bad("webhook 的 headers 必须是字符串键值对象")
        if config.get("secret") is not None and not isinstance(config["secret"], str):
            raise _bad("webhook 的 secret 必须是字符串")
        timeout = config.get("timeout", 10)
    elif action == "command":
        if not isinstance(config.get("cmd"), str) or not config["cmd"].strip():
            raise _bad("command 需要一个非空命令", '例如 {"cmd": "echo event"}；事件 JSON 从 stdin 传入')
        timeout = config.get("timeout", 30)
        if config.get("cwd") is not None and not isinstance(config["cwd"], str):
            raise _bad("command 的 cwd 必须是字符串")
    elif action == "inbox":
        for key in ("title", "body"):
            if config.get(key) is not None and not isinstance(config[key], str):
                raise _bad(f"inbox 的 {key} 必须是字符串")
        timeout = None
    else:
        target = config.get("table")
        if not isinstance(target, str) or not target:
            raise _bad("write 需要目标表 table")
        get_table(conn, did, target)
        mode = config.get("mode", "insert")
        if mode not in ("insert", "update"):
            raise _bad("write 的 mode 只能是 insert 或 update")
        data = config.get("data")
        if data is None:
            config = {**config, "data": {}}
        elif not isinstance(data, dict):
            raise _bad("write 的 data 必须是 JSON 对象")
        if mode == "update" and config.get("record_id") is None:
            raise _bad("write 的 mode=update 需要 record_id", "可以写固定 id，或用 ${record.xxx} 取事件里的值")
        if mode == "insert" and config.get("parent_id") is not None and not isinstance(config["parent_id"], (int, str)):
            raise _bad("write 的 parent_id 必须是 id 或模板字符串")
        if config.get("record_id") is not None and not isinstance(config["record_id"], (int, str)):
            raise _bad("write 的 record_id 必须是 id 或模板字符串")
        timeout = None
    if timeout is not None:
        try:
            timeout = float(timeout)
        except (TypeError, ValueError):
            raise _bad(f"{action} 的 timeout 必须是数字") from None
        if not 0 < timeout <= 600:
            raise _bad(f"{action} 的 timeout 要在 1 到 600 秒之间")
        config = {**config, "timeout": timeout}
    return config


def _validate_binding(conn, domain: str, raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise _bad("绑定必须是 JSON 对象")
    name = raw.get("name")
    if not isinstance(name, str) or not BINDING_NAME_RE.match(name):
        raise _bad(f"绑定名 {name!r} 不合法", "用小写字母开头，只能包含小写字母、数字、下划线和中划线")
    ops = parse_ops(raw.get("ops"))
    if not ops:
        raise _bad("ops 至少选择一个操作", "可用：insert、update、delete")
    did = get_domain(conn, domain)["id"]

    table_name = raw.get("table")
    table = None
    if table_name is not None:
        if not isinstance(table_name, str) or not table_name:
            raise _bad("table 必须是表名")
        table = get_table(conn, did, table_name)
    field = raw.get("field")
    if field is not None:
        if table is None:
            raise _bad("指定 field 时必须同时指定 table")
        if not isinstance(field, str) or table.field(field) is None:
            raise _bad(f"表 {table_name} 没有字段 {field}", "可用字段：" + "、".join(f.key for f in table.active_fields))

    where = raw.get("where")
    if where is not None:
        _check_where(where, "where", table)
    where_before = raw.get("where_before")
    if where_before is not None:
        _check_where(where_before, "where_before", table)

    action = raw.get("action")
    if action not in ACTIONS:
        raise _bad(f"未知的动作 {action!r}", "可用动作：" + "、".join(ACTIONS))
    config = _validate_config(conn, did, domain, action, raw.get("config"))

    prompt = raw.get("prompt")
    if prompt is not None:
        if not isinstance(prompt, str):
            raise _bad("prompt 必须是字符串", "可以写一段给消费方的提示词，支持 ${record.title} 等模板")
        prompt = prompt.strip() or None

    return {
        "name": name,
        "ops": ops,
        "table": table_name,
        "field": field,
        "where": where,
        "where_before": where_before,
        "prompt": prompt,
        "action": action,
        "config": config,
        "enabled": bool(raw.get("enabled", True)),
    }


def create_binding(db, domain: str, raw: dict, *, actor: str) -> dict:
    with db.tx(actor) as tx:
        get_domain(tx.conn, domain)
        b = _validate_binding(tx.conn, domain, raw)
        if tx.conn.execute("SELECT 1 FROM dt_bindings WHERE domain = ? AND name = ?", (domain, b["name"])).fetchone():
            raise DtError("already_exists", f"绑定 {b['name']} 已存在", "换一个名字，或用 dt event unbind 删除后重绑", status=409)
        tx.execute(
            "INSERT INTO dt_bindings (domain, name, ops, table_name, field, where_expr, where_before, prompt, action, config,"
            " enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                domain, b["name"], dumps(b["ops"]), b["table"], b["field"],
                None if b["where"] is None else dumps(b["where"]),
                None if b["where_before"] is None else dumps(b["where_before"]),
                b["prompt"], b["action"], dumps(b["config"]), int(b["enabled"]), actor, tx.ts, tx.ts,
            ),
        )
        return get_binding(tx.conn, domain, b["name"])


def update_binding(db, domain: str, name: str, raw: dict, *, actor: str) -> dict:
    with db.tx(actor) as tx:
        current = get_binding(tx.conn, domain, name)
        merged = {
            "ops": current["ops"],
            "table": current["table_name"],
            "field": current["field"],
            "where": current["where"],
            "where_before": current["where_before"],
            "prompt": current["prompt"],
            "action": current["action"],
            "config": current["config"],
            "enabled": current["enabled"],
            **raw,
            "name": name,
        }
        b = _validate_binding(tx.conn, domain, merged)
        tx.execute(
            "UPDATE dt_bindings SET ops = ?, table_name = ?, field = ?, where_expr = ?, where_before = ?,"
            " prompt = ?, action = ?, config = ?, enabled = ?, updated_at = ? WHERE domain = ? AND name = ?",
            (
                dumps(b["ops"]), b["table"], b["field"],
                None if b["where"] is None else dumps(b["where"]),
                None if b["where_before"] is None else dumps(b["where_before"]),
                b["prompt"], b["action"], dumps(b["config"]), int(b["enabled"]), tx.ts, domain, name,
            ),
        )
        return get_binding(tx.conn, domain, name)


def delete_binding(db, domain: str, name: str, *, actor: str) -> dict:
    with db.tx(actor) as tx:
        get_binding(tx.conn, domain, name)
        tx.execute("DELETE FROM dt_bindings WHERE domain = ? AND name = ?", (domain, name))
        return {"deleted": name}


def _matches(binding: dict, op: str, table_name: str, fields: dict, before, after) -> bool:
    if op not in binding["ops"]:
        return False
    if binding["table_name"] and binding["table_name"] != table_name:
        return False
    if binding["field"] and binding["field"] not in fields:
        return False
    if binding["where"] is not None:
        current = before if op == "delete" else after
        if not match_where(current or {}, binding["where"]):
            return False
    if binding["where_before"] is not None and not match_where(before or {}, binding["where_before"]):
        return False
    return True


def emit(tx: Tx, seq: int, table_name: str, record_id, op: str, before, after, fields: dict):
    """在写事务里记录命中的绑定；同一事务同一绑定的事件在 flush 时合并成一条投递。"""
    if tx.binding_cache is None:
        rows = tx.conn.execute("SELECT * FROM dt_bindings WHERE domain = ? AND enabled = 1", (tx.domain,)).fetchall()
        tx.binding_cache = [binding_from_row(row) for row in rows]
    for binding in tx.binding_cache:
        if _matches(binding, op, table_name, fields, before, after):
            tx.delivery_seqs.setdefault(binding["id"], []).append(seq)


def flush_deliveries(tx: Tx):
    """把内存里按绑定合并的事件写成投递行；一批事件超过上限时拆成多条投递。"""
    if not tx.delivery_seqs or not tx.binding_cache:
        return
    counts = tx.conn.execute(
        "SELECT binding_id, COUNT(*) FROM dt_deliveries WHERE status = 'pending' GROUP BY binding_id"
    ).fetchall()
    pending = {row[0]: row[1] for row in counts}
    for binding in tx.binding_cache:
        seqs = tx.delivery_seqs.get(binding["id"])
        if not seqs:
            continue
        max_pending = int(binding["config"].get("max_pending", DEFAULT_MAX_PENDING))
        for i in range(0, len(seqs), MAX_EVENTS_PER_DELIVERY):
            if pending.get(binding["id"], 0) >= max_pending:
                _warn_cap(binding, max_pending)
                break
            chunk = seqs[i:i + MAX_EVENTS_PER_DELIVERY]
            tx.execute(
                "INSERT INTO dt_deliveries (binding_id, change_seq, last_seq, seqs, event_count, status, attempts,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
                (binding["id"], chunk[0], chunk[-1], dumps(chunk), len(chunk), tx.ts, tx.ts),
            )
            pending[binding["id"]] = pending.get(binding["id"], 0) + 1


# ---------- 投递 ----------

def list_deliveries(conn, domain: str, name: str, status: str | None = None, limit: int = 100) -> list[dict]:
    binding = get_binding(conn, domain, name)
    sql, params = "SELECT * FROM dt_deliveries WHERE binding_id = ?", [binding["id"]]
    if status:
        sql += " AND status = ?"
        params.append(status)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(max(1, min(int(limit), 1000)))
    out = []
    for row in conn.execute(sql, params):
        item = dict(row)
        item["seqs"] = json.loads(item["seqs"]) if item.get("seqs") else None
        out.append(item)
    return out


def get_delivery(conn, domain: str, name: str, delivery_id: int) -> dict:
    """一条投递的详情：状态、时间、结果，以及这次投递携带的完整事件。"""
    binding = get_binding(conn, domain, name)
    row = conn.execute(
        "SELECT * FROM dt_deliveries WHERE id = ? AND binding_id = ?", (delivery_id, binding["id"])
    ).fetchone()
    if row is None:
        raise not_found(f"投递 {delivery_id}", "用 dt event deliveries 查看该绑定的投递")
    item = dict(row)
    item["seqs"] = json.loads(item["seqs"]) if item.get("seqs") else None
    seqs = item["seqs"] or [item["change_seq"]]
    changes = _changes_for_seqs(conn, seqs)
    item["events"] = [event_from_change(changes[seq]) for seq in seqs if seq in changes]
    return item


def retry_binding(db, domain: str, name: str, *, actor: str = "system") -> dict:
    with db.tx(actor) as tx:
        binding = get_binding(tx.conn, domain, name)
        cur = tx.execute(
            "UPDATE dt_deliveries SET status = 'pending', attempts = 0, next_attempt_at = NULL,"
            " last_error = NULL, last_result = NULL, updated_at = ? WHERE binding_id = ? AND status = 'failed'",
            (tx.ts, binding["id"]),
        )
        return {"retried": cur.rowcount}


DUE_SQL = """
SELECT d.id, d.binding_id, d.change_seq, d.last_seq, d.seqs, d.event_count, d.attempts,
       b.name AS binding_name, b.domain, b.action, b.config, b.prompt
FROM dt_deliveries d JOIN dt_bindings b ON b.id = d.binding_id
WHERE d.status = 'pending' AND b.enabled = 1
  AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
  AND NOT EXISTS (
    SELECT 1 FROM dt_deliveries h
    WHERE h.binding_id = d.binding_id AND h.status = 'pending' AND h.change_seq < d.change_seq
  )
ORDER BY d.binding_id, d.change_seq
LIMIT ?
"""


def _delivery_seqs(delivery: dict) -> list[int]:
    seqs = delivery.get("seqs")
    if isinstance(seqs, str):
        seqs = json.loads(seqs) if seqs else None
    return list(seqs) if seqs else [delivery["change_seq"]]


def _changes_for_seqs(conn, seqs: list[int]) -> dict[int, dict]:
    if len(seqs) <= 400:
        marks = ",".join("?" * len(seqs))
        rows = conn.execute(f"SELECT * FROM dt_changes WHERE seq IN ({marks})", tuple(seqs)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM dt_changes WHERE seq IN (SELECT value FROM json_each(?))", (dumps(seqs),)
        ).fetchall()
    return {row["seq"]: _change_row(row) for row in rows}


def _send_webhook(deliveries: list[dict], events: list[dict]):
    first = deliveries[0]
    config = json.loads(first["config"])
    payload = {
        "binding": first["binding_name"],
        "delivery_ids": [delivery["id"] for delivery in deliveries],
        "event_count": len(events),
        "events": events,
    }
    prompt = _render(first.get("prompt"), events[0])
    if prompt:
        payload["prompt"] = str(prompt)
    # 单事件保留旧的 event / delivery_id 字段，方便只处理一条事件的接收方
    if len(events) == 1:
        payload["delivery_id"] = first["id"]
        payload["event"] = events[0]
    body = dumps(payload)
    headers = {
        "Content-Type": "application/json",
        "X-DT-Binding": first["binding_name"],
        "X-DT-Delivery": ",".join(str(delivery["id"]) for delivery in deliveries),
        "X-DT-Event-Seq": str(events[0]["seq"]),
        "X-DT-Event-Count": str(len(events)),
    }
    headers.update(config.get("headers") or {})
    if config.get("secret"):
        headers["X-DT-Signature"] = hmac.new(
            config["secret"].encode(), body.encode(), hashlib.sha256
        ).hexdigest()
    resp = httpx.post(config["url"], content=body, headers=headers, timeout=config.get("timeout", 10))
    resp.raise_for_status()
    return f"HTTP {resp.status_code}"


def _run_command(deliveries: list[dict], events: list[dict]):
    first = deliveries[0]
    config = json.loads(first["config"])
    prompt = _render(first.get("prompt"), events[0])
    env = os.environ.copy()
    env.update({
        "DT_BINDING": first["binding_name"],
        "DT_DOMAIN": first["domain"] or "",
        "DT_OP": events[0]["op"],
        "DT_TABLE": events[0]["table"],
        "DT_RECORD_ID": "" if events[0]["record_id"] is None else str(events[0]["record_id"]),
        "DT_EVENT_SEQ": str(events[0]["seq"]),
        "DT_EVENT_COUNT": str(len(events)),
        "DT_PROMPT": "" if prompt is None else str(prompt),
    })
    timeout = config.get("timeout", 30)
    stdin = "".join(dumps(event) + "\n" for event in events)
    try:
        proc = subprocess.run(
            config["cmd"], shell=True, input=stdin, text=True,
            capture_output=True, timeout=timeout, cwd=config.get("cwd"), env=env,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"命令超时（{timeout:g}s）") from None
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"命令退出码 {proc.returncode}：{detail}")
    return f"退出码 {proc.returncode}"


def _run_write(db, deliveries: list[dict], events: list[dict]):
    first = deliveries[0]
    config = json.loads(first["config"])
    with db.tx(f"binding:{first['binding_name']}", suppress_bindings=True) as tx:
        bind_domain(tx, first["domain"])
        table = get_table(tx.conn, tx.domain_id, config["table"])
        for event in events:
            data = _render(config.get("data") or {}, event)
            if config.get("mode", "insert") == "update":
                record_id = _as_id(_render(config["record_id"], event), "record_id")
                records.update(tx, table, record_id, data)
            else:
                parent_id = None
                if config.get("parent_id") is not None:
                    parent_id = _as_id(_render(config["parent_id"], event), "parent_id")
                records.insert(tx, table, data, parent_id)
    return f"写入 {len(events)} 条"


OP_LABEL = {"insert": "新增", "update": "变更", "delete": "删除"}


def _fmt_value(value) -> str:
    if value is None:
        return "空"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, list):
        return "、".join(_fmt_value(item) for item in value) or "空"
    if isinstance(value, dict):
        picked = value.get("name") or value.get("path") or value.get("value")
        return str(picked) if picked is not None else dumps(value)
    text = str(value)
    return text if len(text) <= 80 else text[:80] + "…"


def _default_title(event: dict, table) -> str:
    label = (table.label or table.name) if table is not None else event["table"]
    return f"{label} #{event['record_id']} {OP_LABEL.get(event['op'], event['op'])}"


def _default_body(event: dict, table) -> str:
    parts = []
    for key, diff in event["fields"].items():
        field = table.field(key) if table is not None else None
        label = (field.label or key) if field is not None else key
        parts.append(f"{label}：{_fmt_value(diff['before'])} → {_fmt_value(diff['after'])}")
    return "\n".join(parts) or "无用户字段变化"


def _run_inbox(db, deliveries: list[dict], events: list[dict]):
    first = deliveries[0]
    config = json.loads(first["config"])
    written = 0
    with db.tx(f"binding:{first['binding_name']}", suppress_bindings=True) as tx:
        bind_domain(tx, first["domain"])
        tables = {}
        for event in events:
            if event["table"] not in tables:
                try:
                    tables[event["table"]] = get_table(tx.conn, tx.domain_id, event["table"])
                except DtError:
                    tables[event["table"]] = None
            table = tables[event["table"]]
            title = _render(config["title"], event) if config.get("title") else None
            body = _render(config["body"], event) if config.get("body") else None
            title = _default_title(event, table) if title is None or title == "" else str(title)
            body = _default_body(event, table) if body is None or body == "" else str(body)
            prompt = _render(first.get("prompt"), event)
            prompt = None if prompt is None or prompt == "" else str(prompt)
            cur = tx.execute(
                "INSERT OR IGNORE INTO dt_inbox (domain, binding_id, binding_name, event_seq, table_name, record_id,"
                " op, title, body, prompt, events, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)",
                (
                    first["domain"], first["binding_id"], first["binding_name"], event["seq"], event["table"],
                    event["record_id"], event["op"], title, body, prompt, dumps([event]), tx.ts,
                ),
            )
            written += cur.rowcount
    return f"写入 {written} 条"


def _mark_many(db, deliveries: list[dict], error: str | None, result: str | None = None):
    """一次事务更新一批投递的状态，成功时把动作结果记进 last_result。"""
    if not deliveries:
        return
    with db.tx("system") as tx:
        for delivery in deliveries:
            attempts = delivery["attempts"] + 1
            if error is None:
                status, next_at, last_error = "sent", None, None
            elif attempts >= len(BACKOFF):
                status, next_at, last_error = "failed", None, error[:1000]
            else:
                status = "pending"
                next_at = (datetime.now(timezone.utc) + timedelta(seconds=BACKOFF[attempts - 1])).isoformat(
                    timespec="milliseconds"
                ).replace("+00:00", "Z")
                last_error = error[:1000]
            tx.execute(
                "UPDATE dt_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,"
                " last_result = ?, updated_at = ? WHERE id = ?",
                (status, attempts, next_at, last_error, result if error is None else None, tx.ts, delivery["id"]),
            )


def _delivery_ids(deliveries: list[dict]) -> str:
    ids = [delivery["id"] for delivery in deliveries]
    return f"#{ids[0]}" if len(ids) == 1 else f"#{ids[0]} 等 {len(ids)} 条"


def dispatch_once(db, limit: int = 50) -> int:
    """执行到期的投递；同一绑定最多合并 config.batch 条投递、一次动作携带多条事件。"""
    stamp = now()
    with db.read() as conn:
        heads = [dict(r) for r in conn.execute(DUE_SQL, (stamp, max(1, min(int(limit), 200))))]
        jobs = []
        for head in heads:
            config = json.loads(head["config"])
            batch = max(1, min(int(config.get("batch", DEFAULT_BATCH)), 1000))
            deliveries = [head]
            if batch > 1:
                extra = conn.execute(
                    "SELECT d.* FROM dt_deliveries d WHERE d.binding_id = ? AND d.status = 'pending'"
                    " AND d.change_seq > ? ORDER BY d.change_seq LIMIT ?",
                    (head["binding_id"], head["change_seq"], batch - 1),
                ).fetchall()
                for row in extra:
                    row = dict(row)
                    if row["next_attempt_at"] and row["next_attempt_at"] > stamp:
                        break
                    deliveries.append(row)

            selected, missing, events = [], [], []
            for delivery in deliveries:
                seqs = _delivery_seqs(delivery)
                changes = _changes_for_seqs(conn, seqs)
                if len(changes) < len(seqs):
                    missing.append(delivery)
                    break  # 顺序投递：中间缺事件就不再往后合并
                chunk = [event_from_change(changes[seq]) for seq in seqs]
                if events and len(events) + len(chunk) > MAX_EVENTS_PER_ACTION:
                    break
                selected.append(delivery)
                events.extend(chunk)
            jobs.append((selected, events, missing))

    processed = 0
    for deliveries, events, missing in jobs:
        if missing:
            _mark_many(db, missing, "对应的事件已经被清理")
            log.warning("投递 %s 对应的事件已被清理，跳过", _delivery_ids(missing))
        processed += len(missing)
        if not deliveries:
            continue
        first = deliveries[0]
        started = time.monotonic()
        try:
            action = first["action"]
            if action == "webhook":
                result = _send_webhook(deliveries, events)
            elif action == "command":
                result = _run_command(deliveries, events)
            elif action == "inbox":
                result = _run_inbox(db, deliveries, events)
            else:
                result = _run_write(db, deliveries, events)
        except Exception as e:  # 单个投递失败不能中断调度，失败的投递会退避重试
            detail = f"{type(e).__name__}: {e}"
            _mark_many(db, deliveries, detail)
            log.warning(
                "投递 %s 绑定 %s（%s）失败，第 %d 次：%s",
                _delivery_ids(deliveries), first["binding_name"], first["action"], first["attempts"] + 1, detail,
            )
        else:
            _mark_many(db, deliveries, None, result)
            log.info(
                "投递 %s 绑定 %s（%s）%d 条事件 → %s，%dms",
                _delivery_ids(deliveries), first["binding_name"], first["action"], len(events),
                result or "成功", int((time.monotonic() - started) * 1000),
            )
        processed += len(deliveries)
    return processed


async def dispatcher_loop(db, interval: float = 0.5):
    last_prune = 0.0
    while True:
        try:
            processed = await asyncio.to_thread(dispatch_once, db, 50)
            if last_prune == 0.0 or datetime.now(timezone.utc).timestamp() - last_prune > 3600:
                await asyncio.to_thread(prune_deliveries, db)
                last_prune = datetime.now(timezone.utc).timestamp()
            if processed == 0:
                await asyncio.sleep(interval)
        except Exception:
            traceback.print_exc()
            await asyncio.sleep(interval)


def _resolve(path: str, event: dict):
    parts = path.split(".")
    cur = event
    if parts and parts[0] == "event":
        parts = parts[1:]
    for part in parts:
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


TEMPLATE_FULL = re.compile(r"^\$\{([^}]+)\}$")
TEMPLATE_ANY = re.compile(r"\$\{([^}]+)\}")


def _render(value, event: dict):
    if isinstance(value, dict):
        return {k: _render(v, event) for k, v in value.items()}
    if isinstance(value, list):
        return [_render(v, event) for v in value]
    if not isinstance(value, str):
        return value
    full = TEMPLATE_FULL.match(value)
    if full:
        return _resolve(full.group(1), event)

    def sub(match):
        resolved = _resolve(match.group(1), event)
        return "" if resolved is None else str(resolved)

    return TEMPLATE_ANY.sub(sub, value)


def _as_id(value, what: str) -> int:
    if isinstance(value, bool):
        raise RuntimeError(f"{what} 不是记录 id")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    raise RuntimeError(f"{what} 不是记录 id：{value!r}")




def prune_deliveries(db, sent_days: int = SENT_RETENTION_DAYS, failed_days: int = FAILED_RETENTION_DAYS) -> dict:
    """清理已投递成功和已失败的旧记录；pending 不清理。"""
    now_dt = datetime.now(timezone.utc)

    def cutoff(days: int) -> str:
        return (now_dt - timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    with db.tx("system") as tx:
        sent = tx.execute(
            "DELETE FROM dt_deliveries WHERE status = 'sent' AND updated_at < ?", (cutoff(sent_days),)
        ).rowcount
        failed = tx.execute(
            "DELETE FROM dt_deliveries WHERE status = 'failed' AND updated_at < ?", (cutoff(failed_days),)
        ).rowcount
    return {"sent": sent, "failed": failed}
