"""读取附件字段里登记过的文件。只认登记过的路径，目录附件只能访问目录内部。"""

import hashlib
import json
import os
from datetime import datetime, timezone

from dt.errors import DtError, not_found
from dt.model import table_by_id

MAX_TREE = 5000


def _record(conn, record_id: int):
    row = conn.execute(
        "SELECT table_id, data FROM dt_records WHERE id = ?", (record_id,)
    ).fetchone()
    if row is None:
        raise not_found(f"记录 {record_id}")
    return table_by_id(conn, row["table_id"]), json.loads(row["data"])


def _items(value) -> list[dict]:
    return value if isinstance(value, list) else [value] if value else []


def get_item(conn, record_id: int, key: str, idx: int) -> dict:
    table, data = _record(conn, record_id)
    f = table.field(key)
    if f is None or f.type != "attachment":
        raise DtError("invalid_value", f"{table.name} 的 {key} 不是附件字段")
    items = _items(data.get(key))
    if not 0 <= idx < len(items):
        raise not_found(f"附件 {key}[{idx}]")
    return items[idx]


def _mtime(path: str) -> str:
    return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def status(item: dict) -> str:
    """ok / missing / changed。mtime 和大小都没变时认为没变，不重新算 sha256。"""
    path = item["path"]
    if item["kind"] == "dir":
        return "ok" if os.path.isdir(path) else "missing"
    if not os.path.isfile(path):
        return "missing"
    if os.path.getsize(path) == item.get("size") and _mtime(path) == item.get("mtime"):
        return "ok"
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return "ok" if digest.hexdigest() == item.get("sha256") else "changed"


def statuses(conn, record_ids: list[int]) -> dict:
    out = {}
    for rid in record_ids:
        try:
            table, data = _record(conn, rid)
        except DtError:
            continue
        fields = {f.key: [status(i) for i in _items(data.get(f.key))] for f in table.active_fields if f.type == "attachment"}
        out[str(rid)] = {k: v for k, v in fields.items() if v}
    return out


def tree(item: dict) -> dict:
    if item["kind"] != "dir":
        raise DtError("invalid_value", f"{item['name']} 不是目录")
    if not os.path.isdir(item["path"]):
        raise not_found(f"目录 {item['path']}")
    entries, truncated = [], False
    for root, dirs, files in os.walk(item["path"]):
        dirs.sort()
        rel = os.path.relpath(root, item["path"])
        for name in sorted(files):
            if len(entries) >= MAX_TREE:
                truncated = True
                break
            full = os.path.join(root, name)
            if os.path.isfile(full):
                path = name if rel == "." else f"{rel}/{name}".replace(os.sep, "/")
                entries.append({"path": path, "size": os.path.getsize(full)})
        if truncated:
            break
    return {"files": entries, "truncated": truncated}


def resolve(item: dict, sub: str | None) -> str:
    if item["kind"] == "file":
        if sub:
            raise DtError("invalid_value", "文件附件不支持 sub 参数")
        path = item["path"]
    else:
        if not sub:
            raise DtError("invalid_value", "目录附件需要用 sub 指定目录内的文件")
        parts = sub.replace("\\", "/").split("/")
        if os.path.isabs(sub) or ".." in parts:
            raise DtError("forbidden", "sub 只能是目录内的相对路径", status=403)
        base = os.path.realpath(item["path"])
        path = os.path.realpath(os.path.join(base, *parts))
        if os.path.commonpath([base, path]) != base:
            raise DtError("forbidden", "sub 指向了目录外部", status=403)
    if not os.path.isfile(path):
        raise not_found(f"文件 {path}", "原文件可能已被删除或移动")
    return path
