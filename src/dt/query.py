"""把查询 DSL（where / sort）编译成 SQL。字段 key 已按命名规则校验过，可以直接拼进 JSON 路径。"""

from dt.errors import DtError
from dt.fields import normalize
from dt.model import Field, Table

OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "is_null"}
SYSTEM_COLUMNS = {
    "_id": "r.id", "_parent_id": "r.parent_id", "_version": "r.version",
    "_created_at": "r.created_at", "_updated_at": "r.updated_at",
    "_created_by": "r.created_by", "_updated_by": "r.updated_by",
}


def _bad(message: str, hint: str | None = None) -> DtError:
    return DtError("invalid_query", message, hint)


def _column(table: Table, key: str) -> tuple[str, Field | None]:
    if key in SYSTEM_COLUMNS:
        return SYSTEM_COLUMNS[key], None
    f = table.field(key)
    if f is None:
        keys = "、".join([*SYSTEM_COLUMNS, *(x.key for x in table.active_fields)])
        raise _bad(f"表 {table.name} 没有字段 {key}", f"可用字段：{keys}")
    if f.type == "checkbox":
        return f"IFNULL(json_extract(r.data, '$.{key}'), 0)", f
    if f.type == "attachment" and not f.is_array:
        return f"json_extract(r.data, '$.{key}.path')", f
    return f"json_extract(r.data, '$.{key}')", f


def _value(f: Field | None, value):
    """把查询值转成和存储一致的类型；选项字段顺便校验选项是否存在。"""
    if f is None or value is None:
        return value
    if f.type in ("number", "checkbox"):
        return normalize(f, value)
    if f.type in ("single_select", "multi_select") and value not in f.option_values():
        raise _bad(f"字段 {f.key} 没有选项 {value!r}", "可选值：" + "、".join(f.option_values()))
    return value


def compile_where(table: Table, where) -> tuple[str, list]:
    if not isinstance(where, dict):
        raise _bad("where 必须是 JSON 对象")
    parts, params = [], []
    for key, cond in where.items():
        if key in ("$and", "$or"):
            if not isinstance(cond, list) or not cond:
                raise _bad(f"{key} 需要一个非空数组")
            subs = [compile_where(table, c) for c in cond]
            parts.append("(" + (" AND " if key == "$and" else " OR ").join(s for s, _ in subs) + ")")
            params += [p for _, ps in subs for p in ps]
            continue
        if key.startswith("$"):
            raise _bad(f"未知的组合运算符 {key}", "只支持 $and 和 $or")
        expr, f = _column(table, key)
        if isinstance(cond, dict):
            unknown = set(cond) - OPS
            if unknown or not cond:
                raise _bad(f"字段 {key} 的条件里有未知运算符 {sorted(unknown)}", "运算符：" + " ".join(sorted(OPS)))
            ops = cond
        else:
            ops = {"eq": cond}
        for op, value in ops.items():
            sql, ps = (_array_op if f is not None and f.is_array else _scalar_op)(expr, f, key, op, value)
            parts.append(sql)
            params += ps
    return " AND ".join(parts) or "1 = 1", params


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
        values = [_value(f, v) for v in _list(key, op, value)]
        marks = ",".join("?" * len(values))
        sql = f"{expr} IN ({marks})" if op == "in" else f"({expr} IS NULL OR {expr} NOT IN ({marks}))"
        return sql, values
    if op == "contains":
        if not isinstance(value, str):
            raise _bad(f"字段 {key} 的 contains 需要字符串")
        return f"instr(lower({expr}), lower(?)) > 0", [value]
    value = _value(f, value)
    if op == "eq":
        return (f"{expr} IS NULL", []) if value is None else (f"{expr} = ?", [value])
    if op == "ne":
        return (f"{expr} IS NOT NULL", []) if value is None else (f"({expr} IS NULL OR {expr} != ?)", [value])
    sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
    return f"{expr} {sym} ?", [value]


def _array_op(expr: str, f: Field, key: str, op: str, value):
    """数组字段（multi_select、多值 link / attachment）：eq/contains 表示全部包含，in 表示包含任意一个。"""
    if op == "is_null":
        return _scalar_op(expr, f, key, op, value)
    member = "json_extract(je.value, '$.path')" if f.type == "attachment" else "je.value"

    def any_of(values):
        marks = ",".join("?" * len(values))
        return f"EXISTS (SELECT 1 FROM json_each(r.data, '$.{key}') je WHERE {member} IN ({marks}))", values

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
