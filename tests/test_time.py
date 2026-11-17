"""datetime / date 字段：时间戳、带不带时区、宽松日期写法，写入和查询都按同一规则换算。"""

from datetime import datetime, timezone

import pytest

from dt.db import Database

SPEC = {"name": "ev", "fields": [{"key": "title", "type": "text"}, {"key": "at", "type": "datetime"}, {"key": "day", "type": "date"}]}
TS = 1793930400  # 2026-11-06T02:00:00Z


def local(y, mo, d, h=0, mi=0):
    """服务所在时区的本地时间对应的 UTC 存储值。"""
    return datetime(y, mo, d, h, mi).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@pytest.fixture
def ev(api):
    api.apply(SPEC)
    return api


@pytest.mark.parametrize("value, stored", [
    (TS, "2026-11-06T02:00:00.000Z"),
    (TS + 0.5, "2026-11-06T02:00:00.500Z"),
    (TS * 1000 + 123, "2026-11-06T02:00:00.123Z"),  # 毫秒
    (str(TS), "2026-11-06T02:00:00.000Z"),
    ("2026-11-06T10:00:00+08:00", "2026-11-06T02:00:00.000Z"),
    ("2026-11-06T02:00:00.123456Z", "2026-11-06T02:00:00.123Z"),
    ("2026-11-06 10:00", local(2026, 11, 6, 10)),  # 不带时区按服务所在时区
    ("2026/11/6 10:00", local(2026, 11, 6, 10)),
])
def test_datetime_inputs(ev, value, stored):
    assert ev.insert("ev", {"at": value})["at"] == stored


@pytest.mark.parametrize("value, stored", [
    ("2026-11-06", "2026-11-06"),
    ("2026/11/6", "2026-11-06"),
    ("2026-11-06T10:00:00+08:00", datetime.fromisoformat("2026-11-06T10:00:00+08:00").astimezone().date().isoformat()),
    (TS, datetime.fromtimestamp(TS).date().isoformat()),
])
def test_date_inputs(ev, value, stored):
    assert ev.insert("ev", {"day": value})["day"] == stored


@pytest.mark.parametrize("field, value", [("at", "下周"), ("at", True), ("at", 1e30), ("day", "2026-02-30"), ("day", [1])])
def test_bad_time_hint(ev, field, value):
    err = ev.err("POST", "/tables/ev/records", {"data": {field: value}})
    assert err["code"] == "invalid_value" and ("时间戳" in err["hint"])


def test_query_converts_values(ev):
    ev.insert("ev", {"title": "早", "at": "2026-11-06T09:00:00+08:00", "day": "2026-11-05"})
    ev.insert("ev", {"title": "晚", "at": TS + 3600, "day": "2026-11-06"})  # 11:00 +08:00
    titles = lambda w: [r["title"] for r in ev.query("ev", where=w, sort="at")]
    # 带时区的字符串、秒和毫秒时间戳，比较结果都一样
    for bound in ("2026-11-06T10:00:00+08:00", TS, TS * 1000, str(TS)):
        assert titles({"at": {"gte": bound}}) == ["晚"]
    assert titles({"at": TS + 3600}) == ["晚"]
    assert titles({"day": {"lte": "2026/11/5"}}) == ["早"]
    assert titles({"_created_at": {"gte": TS}}) == ["早", "晚"]
    assert ev.err("POST", "/tables/ev/query", {"where": {"at": {"gte": "昨天"}}})["code"] == "invalid_query"


def test_migrate_old_values(tmp_path):
    path = tmp_path / "dt.db"
    db = Database(path)
    with db.tx("t") as tx:
        tx.execute("INSERT INTO dt_domains (name, created_at, updated_at) VALUES ('w', 'x', 'x')")
        tx.execute("INSERT INTO dt_tables (domain_id, name, created_at, updated_at) VALUES (1, 'ev', 'x', 'x')")
        tx.execute("INSERT INTO dt_fields (table_id, key, type) VALUES (1, 'at', 'datetime')")
        for v in ("2026-11-06T10:00:00", "2026-11-06T02:00:00Z", "2026-11-06T02:00:00.000Z", "乱写的"):
            tx.execute("INSERT INTO dt_records (table_id, data, created_at, updated_at) VALUES (1, json_object('at', ?), 'x', 'x')", (v,))
    db.conn.close()

    db = Database(path)
    got = [r[0] for r in db.conn.execute("SELECT json_extract(data, '$.at') FROM dt_records ORDER BY id")]
    assert got == [local(2026, 11, 6, 10), "2026-11-06T02:00:00.000Z", "2026-11-06T02:00:00.000Z", "乱写的"]
    assert len(list(tmp_path.glob("dt.db.bak-*"))) == 1
    db.conn.close()
    Database(path).conn.close()  # 已经是新格式，不再备份
    assert len(list(tmp_path.glob("dt.db.bak-*"))) == 1
