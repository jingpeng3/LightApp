"""收件箱：绑定动作 inbox 写入的消息查询与已读状态。"""

import json

from dt.errors import DtError, not_found
from dt.model import get_domain

STATUSES = ("unread", "read")


def message_from_row(row) -> dict:
    out = dict(row)
    out["events"] = json.loads(out["events"]) if out.get("events") else []
    return out


def list_messages(conn, domain: str, status: str | None = None, limit: int = 100, offset: int = 0) -> dict:
    get_domain(conn, domain)
    if status not in (None, *STATUSES):
        raise DtError("invalid_value", "status 只能是 unread 或 read")
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    where = ["domain = ?"]
    params = [domain]
    if status:
        where.append("status = ?")
        params.append(status)
    cond = " AND ".join(where)
    total = conn.execute(f"SELECT COUNT(*) FROM dt_inbox WHERE {cond}", params).fetchone()[0]
    unread = conn.execute(
        "SELECT COUNT(*) FROM dt_inbox WHERE domain = ? AND status = 'unread'", (domain,)
    ).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM dt_inbox WHERE {cond} ORDER BY id DESC LIMIT ? OFFSET ?", (*params, limit, offset)
    ).fetchall()
    return {
        "items": [message_from_row(row) for row in rows],
        "total": total,
        "unread": unread,
        "limit": limit,
        "offset": offset,
    }


def get_message(conn, domain: str, message_id: int) -> dict:
    row = conn.execute("SELECT * FROM dt_inbox WHERE id = ? AND domain = ?", (message_id, domain)).fetchone()
    if row is None:
        raise not_found(f"收件箱消息 {message_id}", "用 dt inbox list 查看当前域的消息")
    return message_from_row(row)


def mark_read(db, domain: str, message_id: int, *, read: bool = True, actor: str = "web") -> dict:
    with db.tx(actor) as tx:
        get_domain(tx.conn, domain)
        row = tx.conn.execute("SELECT id FROM dt_inbox WHERE id = ? AND domain = ?", (message_id, domain)).fetchone()
        if row is None:
            raise not_found(f"收件箱消息 {message_id}", "用 dt inbox list 查看当前域的消息")
        tx.execute(
            "UPDATE dt_inbox SET status = ?, read_at = ? WHERE id = ?",
            ("read" if read else "unread", tx.ts if read else None, message_id),
        )
        return get_message(tx.conn, domain, message_id)


def read_all(db, domain: str, *, actor: str = "web") -> dict:
    with db.tx(actor) as tx:
        get_domain(tx.conn, domain)
        cur = tx.execute(
            "UPDATE dt_inbox SET status = 'read', read_at = ? WHERE domain = ? AND status = 'unread'",
            (tx.ts, domain),
        )
        return {"updated": cur.rowcount}


def delete_message(db, domain: str, message_id: int, *, actor: str = "web") -> dict:
    with db.tx(actor) as tx:
        get_domain(tx.conn, domain)
        cur = tx.execute("DELETE FROM dt_inbox WHERE id = ? AND domain = ?", (message_id, domain))
        if not cur.rowcount:
            raise not_found(f"收件箱消息 {message_id}", "用 dt inbox list 查看当前域的消息")
        return {"deleted": message_id}
