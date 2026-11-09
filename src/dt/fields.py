"""字段类型，以及写入值的校验与规范化。"""

import hashlib
import math
import mimetypes
import os
import re
from datetime import date, datetime, timezone
from urllib.parse import urlparse

from dt.errors import DtError
from dt.model import Field

TYPES = (
    "text", "long_text", "number", "date", "datetime", "checkbox", "single_select", "multi_select",
    "url", "email", "person", "auto_number", "link", "attachment",
)
SELECT_TYPES = ("single_select", "multi_select")
UNIQUE_TYPES = ("text", "long_text", "number", "date", "datetime", "single_select", "url", "email", "person", "link")
COLORS = ("blue", "green", "yellow", "orange", "red", "purple", "pink", "cyan", "gray")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _bad(f: Field, value, expect: str) -> DtError:
    return DtError("invalid_value", f"字段 {f.key} 的值 {value!r} 无效", f"{f.key}（{f.type}）需要{expect}")


def _options_hint(f: Field) -> str:
    return "可选值：" + "、".join(f.option_values())


def normalize(f: Field, value, *, conn=None, domain_id=None, actor=None, ts=None, prev=None):
    """校验写入值并转成存储格式。返回 None 表示清空。"""
    if value is None or value == "" or value == []:
        return None
    t = f.type
    if t == "auto_number":
        raise DtError("readonly_field", f"字段 {f.key} 是自动编号，不能写入", "插入时会自动分配，不要传这个字段")
    if t in ("text", "long_text", "person"):
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise _bad(f, value, "字符串")
        return str(value)
    if t == "number":
        return _number(f, value)
    if t == "date":
        if not isinstance(value, str) or not DATE_RE.match(value):
            raise _bad(f, value, " YYYY-MM-DD 格式的日期")
        try:
            date.fromisoformat(value)
        except ValueError:
            raise _bad(f, value, " YYYY-MM-DD 格式的日期") from None
        return value
    if t == "datetime":
        return _datetime(f, value)
    if t == "checkbox":
        if isinstance(value, bool):
            return value
        if value in ("true", "false"):
            return value == "true"
        raise _bad(f, value, " true 或 false")
    if t == "single_select":
        if not isinstance(value, str) or value not in f.option_values():
            raise DtError("invalid_value", f"字段 {f.key} 没有选项 {value!r}", _options_hint(f))
        return value
    if t == "multi_select":
        items = [value] if isinstance(value, str) else value
        if not isinstance(items, list):
            raise _bad(f, value, "选项值数组")
        bad = [v for v in items if v not in f.option_values()]
        if bad:
            raise DtError("invalid_value", f"字段 {f.key} 没有选项 {bad!r}", _options_hint(f))
        return list(dict.fromkeys(items))
    if t == "url":
        u = urlparse(value) if isinstance(value, str) else None
        if not u or u.scheme not in ("http", "https") or not u.netloc:
            raise _bad(f, value, " http:// 或 https:// 开头的链接")
        return value
    if t == "email":
        if not isinstance(value, str) or not EMAIL_RE.match(value):
            raise _bad(f, value, "邮箱地址")
        return value
    if t == "link":
        return _link(f, value, conn, domain_id)
    if t == "attachment":
        return _attachment(f, value, actor, ts, prev)
    raise DtError("invalid_value", f"未知字段类型 {t}")


def _number(f: Field, value):
    if isinstance(value, bool):
        raise _bad(f, value, "数字")
    if isinstance(value, str):
        try:
            value = int(value)
        except ValueError:
            try:
                value = float(value)
            except ValueError:
                raise _bad(f, value, "数字") from None
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _bad(f, value, "数字")
    return value


def _datetime(f: Field, value):
    if not isinstance(value, str):
        raise _bad(f, value, " ISO 8601 时间")
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise _bad(f, value, " ISO 8601 时间，如 2026-11-06T10:00:00+08:00") from None
    if dt.tzinfo is None:
        return dt.isoformat(timespec="seconds")
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _link(f: Field, value, conn, domain_id):
    from dt.model import get_table

    multiple = f.config.get("multiple", False)
    items = value if isinstance(value, list) else [value]
    if not multiple and len(items) > 1:
        raise _bad(f, value, "单个记录 id")
    ids = []
    for v in items:
        if isinstance(v, bool) or not isinstance(v, (int, str)) or not str(v).isdigit():
            raise _bad(f, value, f"{f.config['table']} 的记录 id")
        ids.append(int(v))
    ids = list(dict.fromkeys(ids))
    target = get_table(conn, domain_id, f.config["table"])
    marks = ",".join("?" * len(ids))
    found = {r[0] for r in conn.execute(f"SELECT id FROM dt_records WHERE table_id = ? AND id IN ({marks})", (target.id, *ids))}
    missing = [i for i in ids if i not in found]
    if missing:
        raise DtError("invalid_value", f"字段 {f.key} 引用的 {target.name} 记录 {missing} 不存在", f"用 dt rec query {target.name} 查找记录 id")
    return ids if multiple else ids[0]


def _attachment(f: Field, value, actor, ts, prev):
    multiple = f.config.get("multiple", False)
    items = value if isinstance(value, list) else [value]
    if not multiple and len(items) > 1:
        raise _bad(f, value, "单个绝对路径")
    prev_items = prev if isinstance(prev, list) else [prev] if prev else []
    known = {p["path"]: p for p in prev_items}
    out = {}
    for item in items:
        if isinstance(item, dict) and item.get("path") in known:
            # 原样传回已登记的附件（比如页面保存整行时）就不重新读文件
            out[item["path"]] = known[item["path"]]
            continue
        path = item.get("path") if isinstance(item, dict) else item
        if not isinstance(path, str):
            raise _bad(f, value, "绝对路径字符串")
        meta = _file_meta(f, path)
        old = known.get(meta["path"])
        meta["added_at"] = old["added_at"] if old else ts
        meta["added_by"] = old["added_by"] if old else actor
        out[meta["path"]] = meta
    result = list(out.values())
    return result if multiple else result[0]


def _file_meta(f: Field, path: str) -> dict:
    if not os.path.isabs(path):
        raise DtError("invalid_value", f"附件路径 {path!r} 不是绝对路径", "附件只接受绝对路径，例如 /Users/me/out/report.md")
    path = os.path.normpath(path)
    if not os.path.exists(path):
        raise DtError("invalid_value", f"附件路径 {path} 不存在", "确认文件已经生成，并检查路径拼写")
    name = os.path.basename(path)
    mtime = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if os.path.isdir(path):
        count = size = 0
        for root, _, files in os.walk(path):
            for fn in files:
                fp = os.path.join(root, fn)
                if os.path.isfile(fp):
                    count += 1
                    size += os.path.getsize(fp)
        return {"path": path, "name": name, "kind": "dir", "size": size, "file_count": count, "mtime": mtime}
    accept = f.config.get("accept")
    if accept and not name.lower().endswith(tuple(accept)):
        raise DtError("invalid_value", f"附件 {name} 的类型不被字段 {f.key} 接受", "允许的扩展名：" + "、".join(accept))
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return {
        "path": path, "name": name, "kind": "file", "size": os.path.getsize(path),
        "mime": mimetypes.guess_type(name)[0], "sha256": digest.hexdigest(), "mtime": mtime,
    }


def convert(old: Field, new: Field, value, *, conn=None, domain_id=None, actor=None, ts=None):
    """字段定义变了之后转换已有的值；转换不了返回 None（清空）。"""
    if value is None:
        return None
    if old.type == new.type == "attachment":
        items = value if isinstance(value, list) else [value]
        return items if new.config.get("multiple") else items[0]
    if isinstance(value, list):
        if new.type == "multi_select":
            value = [v for v in value if v in new.option_values()]
        elif not new.is_array:
            value = value[0]  # 多值变单值时保留第一个
    elif isinstance(value, dict):
        value = value.get("path")  # 附件转成别的类型时保留路径
    try:
        return normalize(new, value, conn=conn, domain_id=domain_id, actor=actor, ts=ts)
    except DtError:
        return None
