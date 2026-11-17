"""把查询 DSL（where / sort）编译成 SQL。字段 key 已按命名规则校验过，可以直接拼进 JSON 路径。

记录表的别名默认是 r；$child 的子查询给子表用 rc、rcc……，这样多级嵌套时内外层不会混。
"""

import re
from datetime import date, datetime, time, timedelta, timezone

from dt.errors import DtError
from dt.fields import DATE_HINT, DATETIME_HINT, normalize, to_date, to_datetime
from dt.model import Field, Table

OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "is_null"}
SYSTEM_COLUMNS = {
    "_id": "id", "_parent_id": "parent_id", "_version": "version",
    "_created_at": "created_at", "_updated_at": "updated_at",
    "_created_by": "created_by", "_updated_by": "updated_by",
}
TIMESTAMP_COLUMNS = {"_created_at", "_updated_at"}
# $search 在这些字段里找子串；多选和附件按每个值找
TEXT_TYPES = ("text", "long_text", "url", "email", "person", "single_select")
RELATIVE_RE = re.compile(r"^\$(today|week_start|month_start)(?:([+-]\d+)d)?$")
NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")


def _bad(message: str, hint: str | None = None) -> DtError:
    return DtError("invalid_query", message, hint)


def _column(table: Table, key: str, a: str = "r") -> tuple[str, Field | None]:
    if key in SYSTEM_COLUMNS:
        return f"{a}.{SYSTEM_COLUMNS[key]}", None
    f = table.field(key)
    if f is None:
        keys = "、".join([*SYSTEM_COLUMNS, *(x.key for x in table.active_fields)])
        raise _bad(f"表 {table.name} 没有字段 {key}", f"可用字段：{keys}")
    if f.type == "checkbox":
        return f"IFNULL(json_extract({a}.data, '$.{key}'), 0)", f
    if f.type == "attachment" and not f.is_array:
        return f"json_extract({a}.data, '$.{key}.path')", f
    return f"json_extract({a}.data, '$.{key}')", f


def _relative(key: str, f: Field | None, value):
    """日期字段上的 $today、$week_start、$month_start（可带 ±Nd 偏移）按服务所在机器的本地日期换算。
    date 字段换成 YYYY-MM-DD；datetime 字段和 _created_at / _updated_at 换成当天 0 点的 UTC 时间。"""
    is_ts = key in TIMESTAMP_COLUMNS or (f is not None and f.type == "datetime")
    if not isinstance(value, str) or not value.startswith("$") or not (is_ts or (f is not None and f.type == "date")):
        return value
    m = RELATIVE_RE.match(value)
    if not m:
        raise _bad(f"字段 {key} 的值 {value} 不是可识别的相对日期", "可用 $today、$week_start（本周一）、$month_start，可以加偏移，如 $today-7d")
    today = date.today()
    base = {"today": today, "week_start": today - timedelta(days=today.weekday()), "month_start": today.replace(day=1)}[m[1]]
    day = base + timedelta(days=int(m[2] or 0))
    if not is_ts:
        return day.isoformat()
    midnight = datetime.combine(day, time()).astimezone()
    return midnight.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _time(key: str, f: Field | None, value):
    """日期和时间的查询值按写入时的规则换算（时间戳、带时区的字符串都行），这样按字符串比较才等于按时间比较。"""
    is_ts = key in TIMESTAMP_COLUMNS or (f is not None and f.type == "datetime")
    if value is None or not (is_ts or (f is not None and f.type == "date")):
        return value
    try:
        return to_datetime(value) if is_ts else to_date(value)
    except ValueError:
        raise _bad(f"字段 {key} 的查询值 {value!r} 不是可识别的{'时间' if is_ts else '日期'}",
                   f"{key} 需要{DATETIME_HINT if is_ts else DATE_HINT}；也可以写 $today 这类相对日期") from None


def _value(f: Field | None, value, key: str = ""):
    """把查询值转成和存储一致的类型；选项字段顺便校验选项是否存在。"""
    value = _time(key, f, _relative(key, f, value))
    if f is None or value is None:
        return value
    if f.type in ("number", "checkbox"):
        return normalize(f, value)
    if f.type in ("single_select", "multi_select") and value not in f.option_values():
        raise _bad(f"字段 {f.key} 没有选项 {value!r}", "可选值：" + "、".join(f.option_values()))
    return value


def compile_where(table: Table, where, conn=None, a: str = "r") -> tuple[str, list]:
    """conn 用来读子表结构，只有 $child 需要。"""
    if not isinstance(where, dict):
        raise _bad("where 必须是 JSON 对象")
    parts, params = [], []
    for key, cond in where.items():
        if key in ("$and", "$or"):
            if not isinstance(cond, list) or not cond:
                raise _bad(f"{key} 需要一个非空数组")
            subs = [compile_where(table, c, conn, a) for c in cond]
            parts.append("(" + (" AND " if key == "$and" else " OR ").join(s for s, _ in subs) + ")")
            params += [p for _, ps in subs for p in ps]
            continue
        if key == "$search":
            sql, ps = _search(table, cond, a)
            parts.append(sql)
            params += ps
            continue
        if key == "$child":
            sql, ps = _child(table, cond, conn, a)
            parts.append(sql)
            params += ps
            continue
        if key.startswith("$"):
            raise _bad(f"未知的组合运算符 {key}", "只支持 $and、$or、$search 和 $child")
        expr, f = _column(table, key, a)
        if isinstance(cond, dict):
            unknown = set(cond) - OPS
            if unknown or not cond:
                raise _bad(f"字段 {key} 的条件里有未知运算符 {sorted(unknown)}", "运算符：" + " ".join(sorted(OPS)))
            ops = cond
        else:
            ops = {"eq": cond}
        for op, value in ops.items():
            if f is not None and f.is_array:
                sql, ps = _array_op(expr, f, key, op, value, a)
            else:
                sql, ps = _scalar_op(expr, f, key, op, value)
            parts.append(sql)
            params += ps
    return " AND ".join(parts) or "1 = 1", params


def _search(table: Table, value, a: str) -> tuple[str, list]:
    """按空白拆成多个词，每个词都要在某个字段里出现：文本类字段找子串（不区分大小写），
    多选和附件看任意一个值，数字字段和 _id 要相等（_id 可以写成 #12）。"""
    if not isinstance(value, str):
        raise _bad("$search 需要字符串")
    parts, params = [], []
    for term in value.split():
        ors, ps = [], []
        for f in table.active_fields:
            expr = f"json_extract({a}.data, '$.{f.key}')"
            if f.type in TEXT_TYPES:
                ors.append(f"instr(lower({expr}), lower(?)) > 0")
            elif f.type == "multi_select" or (f.type == "attachment" and f.is_array):
                member = "json_extract(je.value, '$.path')" if f.type == "attachment" else "je.value"
                ors.append(f"EXISTS (SELECT 1 FROM json_each({a}.data, '$.{f.key}') je WHERE instr(lower({member}), lower(?)) > 0)")
            elif f.type == "attachment":
                ors.append(f"instr(lower(json_extract({a}.data, '$.{f.key}.path')), lower(?)) > 0")
            elif f.type in ("number", "auto_number") and NUMBER_RE.match(term):
                ors.append(f"{expr} = ?")
                ps.append(float(term) if "." in term else int(term))
                continue
            else:
                continue
            ps.append(term)
        if re.fullmatch(r"#?\d+", term):
            ors.append(f"{a}.id = ?")
            ps.append(int(term.lstrip("#")))
        parts.append("(" + " OR ".join(ors) + ")" if ors else "0")
        params += ps
    return " AND ".join(parts) or "1 = 1", params


def _child(table: Table, cond, conn, a: str) -> tuple[str, list]:
    """父记录下至少有一条子记录满足条件；子表的 where 里还可以再写 $child。"""
    if not isinstance(cond, dict) or not isinstance(cond.get("table"), str) or set(cond) - {"table", "where"}:
        raise _bad('$child 要写成 {"table": "<子表>", "where": {...}}', "where 省略时表示至少有一条子记录")
    name = cond["table"]
    if name not in table.children:
        raise _bad(f"{name} 不是 {table.name} 的子表", "子表：" + ("、".join(table.children) or "无"))
    if conn is None:
        raise _bad("这里的条件不支持 $child")
    from dt.model import get_table

    child = get_table(conn, table.domain_id, name)
    c = a + "c"
    sub, ps = compile_where(child, cond.get("where") or {}, conn, c)
    return f"EXISTS (SELECT 1 FROM dt_records {c} WHERE {c}.table_id = ? AND {c}.parent_id = {a}.id AND {sub})", [child.id, *ps]


def _list(key: str, op: str, value) -> list:
    if not isinstance(value, list) or not value:
        raise _bad(f"字段 {key} 的 {op} 需要非空数组")
    return value


def _scalar_op(expr: str, f: Field | None, key: str, op: str, value):
    if op == "is_null":
        if not isinstance(value, bool):
            raise _bad(f"字段 {key} 的 is_null 需要 true 或 false")
        return f"{expr} IS {'' if value else 'NOT '}NULL", []
    if op in ("in", "nin"):
        values = [_value(f, v, key) for v in _list(key, op, value)]
        marks = ",".join("?" * len(values))
        sql = f"{expr} IN ({marks})" if op == "in" else f"({expr} IS NULL OR {expr} NOT IN ({marks}))"
        return sql, values
    if op == "contains":
        if not isinstance(value, str):
            raise _bad(f"字段 {key} 的 contains 需要字符串")
        return f"instr(lower({expr}), lower(?)) > 0", [value]
    value = _value(f, value, key)
    if op == "eq":
        return (f"{expr} IS NULL", []) if value is None else (f"{expr} = ?", [value])
    if op == "ne":
        return (f"{expr} IS NOT NULL", []) if value is None else (f"({expr} IS NULL OR {expr} != ?)", [value])
    sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
    return f"{expr} {sym} ?", [value]


def _array_op(expr: str, f: Field, key: str, op: str, value, a: str = "r"):
    """数组字段（multi_select、多值 link / attachment）：eq/contains 表示全部包含，in 表示包含任意一个。"""
    if op == "is_null":
        return _scalar_op(expr, f, key, op, value)
    member = "json_extract(je.value, '$.path')" if f.type == "attachment" else "je.value"

    def any_of(values):
        marks = ",".join("?" * len(values))
        return f"EXISTS (SELECT 1 FROM json_each({a}.data, '$.{key}') je WHERE {member} IN ({marks}))", values

    if op in ("eq", "contains"):
        values = [_value(f, v) for v in (value if isinstance(value, list) else [value])]
        if not values:
            raise _bad(f"字段 {key} 的 {op} 至少需要一个值", "判断为空用 is_null")
        subs = [any_of([v]) for v in values]
        return "(" + " AND ".join(s for s, _ in subs) + ")", values
    if op in ("in", "nin", "ne"):
        values = [_value(f, v) for v in (_list(key, op, value) if op != "ne" else [value])]
        sql, ps = any_of(values)
        return (sql, ps) if op == "in" else (f"NOT {sql}", ps)
    raise _bad(f"数组字段 {key} 不支持 {op}", "数组字段支持 eq contains in nin ne is_null")


def compile_sort(table: Table, sort) -> str:
    parts = []
    for item in (sort or "").split(","):
        item = item.strip()
        if not item:
            continue
        desc = item.startswith("-")
        expr, _ = _column(table, item.lstrip("+-"))
        parts.append(f"{expr} {'DESC' if desc else 'ASC'}")
    parts.append("r.id")
    return ", ".join(parts)
