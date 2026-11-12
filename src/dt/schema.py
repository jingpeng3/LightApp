"""模版 spec 的解析，以及声明式 apply：对比 spec 和数据库现状，生成计划再执行。"""

import json
import re
from dataclasses import dataclass, field as dc_field
from typing import Callable

from dt.db import Tx, dumps
from dt.errors import DtError
from dt.fields import COLORS, SELECT_TYPES, TYPES, UNIQUE_TYPES, convert, normalize
from dt.model import Field, Table, bind_domain, get_domain, get_table, list_tables, load_table
from dt.records import write_data

NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
TABLE_KEYS = {"name", "label", "description", "relation", "on_delete", "fields", "children", "parent"}
FIELD_KEYS = {"key", "label", "description", "type", "required", "unique", "default", "options", "config"}
RELATIONS = ("one_to_many", "one_to_one")
ON_DELETE = ("cascade", "restrict")
MATCH_TYPES = ("text", "number", "url", "email")  # 能声明同值关联（config.match）的字段类型


def _err(message: str, hint: str | None = None) -> DtError:
    return DtError("invalid_spec", message, hint)


@dataclass
class TableSpec:
    name: str
    label: str | None
    description: str | None
    relation: str
    on_delete: str
    fields: list[Field]
    children: list["TableSpec"]
    parent: str | None = None


def _name(value, what: str) -> str:
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise _err(f"{what} {value!r} 不合法", "只能用小写字母、数字和下划线，以字母开头，最长 63 个字符")
    return value


def _text(raw: dict, key: str, where: str):
    value = raw.get(key)
    if value is not None and not isinstance(value, str):
        raise _err(f"{where} 的 {key} 必须是字符串")
    return value


def _bool(raw: dict, key: str, where: str) -> bool:
    value = raw.get(key, False)
    if not isinstance(value, bool):
        raise _err(f"{where} 的 {key} 必须是 true 或 false")
    return value


def parse_spec(raw, *, is_root: bool = True) -> TableSpec:
    if not isinstance(raw, dict):
        raise _err("表定义必须是对象")
    name = _name(raw.get("name"), "表名")
    allowed = TABLE_KEYS if is_root else TABLE_KEYS - {"parent"}
    unknown = set(raw) - allowed
    if unknown:
        raise _err(f"表 {name} 有未知属性 {sorted(unknown)}", "可用属性：" + "、".join(sorted(allowed)))
    parent = _name(raw["parent"], "父表名") if raw.get("parent") is not None else None
    if is_root and parent is None and ("relation" in raw or "on_delete" in raw):
        raise _err(f"表 {name} 不是子表，不能设置 relation / on_delete")
    relation = raw.get("relation", "one_to_many")
    if relation not in RELATIONS:
        raise _err(f"表 {name} 的 relation {relation!r} 不合法", "可选：one_to_many、one_to_one")
    on_delete = raw.get("on_delete", "cascade")
    if on_delete not in ON_DELETE:
        raise _err(f"表 {name} 的 on_delete {on_delete!r} 不合法", "可选：cascade、restrict")
    fields_raw = raw.get("fields") or []
    children_raw = raw.get("children") or []
    if not isinstance(fields_raw, list) or not isinstance(children_raw, list):
        raise _err(f"表 {name} 的 fields 和 children 必须是数组")
    fields = [parse_field(f, name) for f in fields_raw]
    keys = [f.key for f in fields]
    dup = {k for k in keys if keys.count(k) > 1}
    if dup:
        raise _err(f"表 {name} 的字段 {sorted(dup)} 重复")
    children = [parse_spec(c, is_root=False) for c in children_raw]
    clash = {c.name for c in children} & set(keys)
    if clash:
        raise _err(f"子表名 {sorted(clash)} 和表 {name} 的字段重名", "子表数据会放在同名 key 下，请换一个名字")
    return TableSpec(name, _text(raw, "label", name), _text(raw, "description", name), relation, on_delete, fields, children, parent)


def parse_field(raw, table: str) -> Field:
    if not isinstance(raw, dict):
        raise _err(f"表 {table} 的字段定义必须是对象")
    key = _name(raw.get("key"), f"表 {table} 的字段 key")
    where = f"字段 {table}.{key}"
    unknown = set(raw) - FIELD_KEYS
    if unknown:
        raise _err(f"{where} 有未知属性 {sorted(unknown)}", "可用属性：" + "、".join(sorted(FIELD_KEYS)))
    ftype = raw.get("type")
    if ftype not in TYPES:
        raise _err(f"{where} 的类型 {ftype!r} 不支持", "可用类型：" + "、".join(TYPES))
    options = None
    if ftype in SELECT_TYPES:
        options = _options(raw.get("options"), where)
    elif raw.get("options") is not None:
        raise _err(f"{where} 不是选项字段，不能设置 options")
    f = Field(
        key=key, type=ftype, label=_text(raw, "label", where), description=_text(raw, "description", where),
        required=_bool(raw, "required", where), unique=_bool(raw, "unique", where),
        options=options, config=_config(ftype, raw.get("config"), where),
    )
    if f.unique and (ftype not in UNIQUE_TYPES or f.is_array):
        raise _err(f"{where} 的类型 {ftype} 不支持 unique")
    if raw.get("default") is not None:
        if ftype in ("auto_number", "link", "attachment"):
            raise _err(f"{where} 的类型 {ftype} 不支持 default")
        try:
            f.default = normalize(f, raw["default"])
        except DtError as e:
            raise _err(f"{where} 的 default 无效：{e.message}", e.hint) from None
    return f


def _options(raw, where: str) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise _err(f"{where} 需要 options", "例如 options: [待办, 进行中, 完成]，或 [{value: 待办, color: gray}]")
    out = []
    for item in raw:
        if isinstance(item, str):
            item = {"value": item}
        if not isinstance(item, dict) or not isinstance(item.get("value"), str) or not item["value"]:
            raise _err(f"{where} 的选项 {item!r} 不合法", "选项是字符串，或 {value, color} 对象")
        color = item.get("color")
        if color is not None and color not in COLORS:
            raise _err(f"{where} 的选项颜色 {color!r} 不支持", "可用颜色：" + "、".join(COLORS))
        out.append({"value": item["value"], "color": color})
    values = [o["value"] for o in out]
    if len(set(values)) != len(values):
        raise _err(f"{where} 有重复的选项")
    return out


def _config(ftype: str, raw, where: str) -> dict:
    raw = raw or {}
    if not isinstance(raw, dict):
        raise _err(f"{where} 的 config 必须是对象")
    allowed = {"link": {"table", "multiple"}, "attachment": {"multiple", "accept"}}.get(ftype, {"match", "self"} if ftype in MATCH_TYPES else set())
    unknown = set(raw) - allowed
    if unknown:
        hint = ("可用：" + "、".join(sorted(allowed))) if allowed else "该类型没有 config"
        if "match" in unknown:
            hint += "；match 只能用在 " + "、".join(MATCH_TYPES) + " 字段上"
        raise _err(f"{where} 的 config 有未知属性 {sorted(unknown)}", hint)
    out = {}
    if raw.get("match") is not None:
        out["match"] = _name(raw["match"], f"{where} 的 config.match")
    if raw.get("self") is not None:
        if not isinstance(raw["self"], bool):
            raise _err(f"{where} 的 config.self 必须是 true 或 false")
        if "match" not in out:
            raise _err(f"{where} 的 config.self 要和 match 一起写", "例如 config: {match: sn, self: true}")
        if raw["self"]:
            out["self"] = True
    if "multiple" in raw:
        if not isinstance(raw["multiple"], bool):
            raise _err(f"{where} 的 config.multiple 必须是 true 或 false")
        out["multiple"] = raw["multiple"]
    if ftype == "link":
        out["table"] = _name(raw.get("table"), f"{where} 的 config.table")
    if raw.get("accept") is not None:
        accept = raw["accept"]
        if not isinstance(accept, list) or not all(isinstance(a, str) and a.strip(".") for a in accept):
            raise _err(f"{where} 的 config.accept 必须是扩展名数组", "例如 accept: [.md, .png]")
        out["accept"] = ["." + a.lower().lstrip(".") for a in accept]
    return out


def fill_colors(options, existing=None):
    """没写颜色的选项沿用已有颜色，新选项按顺序分配。"""
    if options is None:
        return None
    old = {o["value"]: o["color"] for o in existing or []}
    return [
        {"value": o["value"], "color": o["color"] or old.get(o["value"]) or COLORS[i % len(COLORS)]}
        for i, o in enumerate(options)
    ]


# ---------- 输出 ----------

def field_to_dict(f: Field) -> dict:
    out = {"key": f.key, "type": f.type}
    for k in ("label", "description"):
        if getattr(f, k):
            out[k] = getattr(f, k)
    if f.required:
        out["required"] = True
    if f.unique:
        out["unique"] = True
    if f.default is not None:
        out["default"] = f.default
    if f.options is not None:
        out["options"] = f.options
    if f.config:
        out["config"] = f.config
    return out


def table_to_dict(conn, table: Table, *, tree: bool = True) -> dict:
    out = {"name": table.name, "label": table.label, "description": table.description, "parent": table.parent}
    if table.parent:
        out["relation"] = table.relation
        out["on_delete"] = table.on_delete
    out["schema_version"] = table.schema_version
    out["record_count"] = conn.execute("SELECT COUNT(*) FROM dt_records WHERE table_id = ?", (table.id,)).fetchone()[0]
    out["fields"] = [field_to_dict(f) for f in table.active_fields]
    archived = [f.key for f in table.fields if f.archived]
    if archived:
        out["archived_fields"] = archived
    if tree:
        out["children"] = [table_summary(conn, get_table(conn, table.domain_id, c)) for c in table.children]
    else:
        out["children"] = table.children
    return out


def table_summary(conn, table: Table) -> dict:
    """表的概要：名字、描述、关系和子表树，不含字段。用于渐进式披露的第一层（dt domain show）。"""
    out = {"name": table.name, "label": table.label, "description": table.description}
    if table.parent:
        out["relation"] = table.relation
    out["record_count"] = conn.execute("SELECT COUNT(*) FROM dt_records WHERE table_id = ?", (table.id,)).fetchone()[0]
    out["children"] = [table_summary(conn, get_table(conn, table.domain_id, c)) for c in table.children]
    return out


def spec_warnings(specs: list[TableSpec]) -> list[str]:
    """agent 靠描述决定用哪张表、哪个字段，缺描述时提醒补上。"""
    out = []

    def walk(spec: TableSpec):
        if not spec.description:
            out.append(f"表 {spec.name} 没有 description，agent 只能靠表名猜它的用途")
        for f in spec.fields:
            if not f.description and not f.label:
                out.append(f"字段 {spec.name}.{f.key} 没有 label 和 description")
        for c in spec.children:
            walk(c)

    for spec in specs:
        walk(spec)
    return out


# ---------- 计划 ----------

@dataclass
class Step:
    op: str
    table: str
    detail: str
    field: str | None = None
    destructive: bool = False
    run: Callable[[Tx], None] | None = dc_field(default=None, repr=False)

    def to_dict(self) -> dict:
        out = {"op": self.op, "table": self.table}
        if self.field:
            out["field"] = self.field
        out["detail"] = self.detail
        out["destructive"] = self.destructive
        return out


def _spec_names(spec: TableSpec, acc: list) -> list:
    acc.append(spec.name)
    for c in spec.children:
        _spec_names(c, acc)
    return acc


def plan(conn, did: int | None, specs: list[TableSpec]) -> list[Step]:
    names = [n for spec in specs for n in _spec_names(spec, [])]
    dup = {n for n in names if names.count(n) > 1}
    if dup:
        raise _err(f"spec 里的表名 {sorted(dup)} 重复", "表名在一个域里唯一")
    steps: list[Step] = []
    for spec in specs:
        _plan_table(conn, did, spec, spec.parent, set(names), steps, is_root=True)
    return steps


def _check_links(conn, did, spec: TableSpec, known: set):
    for f in spec.fields:
        if f.type == "link" and f.config["table"] not in known and load_table(conn, did, f.config["table"]) is None:
            raise _err(f"字段 {spec.name}.{f.key} 引用的表 {f.config['table']} 不在这个域里", "link 只能引用同一个域里的表")


def _plan_table(conn, did, spec: TableSpec, parent: str | None, known: set, steps: list, *, is_root: bool):
    _check_links(conn, did, spec, known)
    existing = load_table(conn, did, spec.name)
    if existing is None:
        if parent is not None and parent not in known and load_table(conn, did, parent) is None:
            raise _err(f"父表 {parent} 不存在")
        steps.append(Step("create_table", spec.name, f"新建表，{len(spec.fields)} 个字段" + (f"，父表 {parent}" if parent else ""),
                          run=lambda tx, s=spec, p=parent: _create_table(tx, s, p)))
    else:
        if (parent is not None or not is_root) and existing.parent != parent:
            raise DtError("not_allowed", f"表 {spec.name} 已经存在，父表是 {existing.parent or '无'}，不能改成 {parent or '无'}",
                          "子表的父表不能修改；如果要换结构，先 dt table drop 再重新建")
        _plan_existing(conn, existing, spec, steps)
    for child in spec.children:
        _plan_table(conn, did, child, spec.name, known, steps, is_root=False)


def _plan_existing(conn, table: Table, spec: TableSpec, steps: list):
    changes, destructive = [], False
    for attr in ("label", "description"):
        if getattr(spec, attr) != getattr(table, attr):
            changes.append(f"{attr}: {getattr(table, attr)!r} → {getattr(spec, attr)!r}")
    if table.parent:
        for attr in ("relation", "on_delete"):
            if getattr(spec, attr) != getattr(table, attr):
                changes.append(f"{attr}: {getattr(table, attr)} → {getattr(spec, attr)}")
                destructive = True
    if changes:
        steps.append(Step("update_table", table.name, "；".join(changes), destructive=destructive,
                          run=lambda tx, t=table, s=spec: _update_table(tx, t, s)))

    old_by_key = {f.key: f for f in table.fields}
    for f in spec.fields:
        old = old_by_key.get(f.key)
        if old is None:
            steps.append(Step("add_field", table.name, f"新增字段（{f.type}）", field=f.key,
                              run=lambda tx, t=table.name, nf=f: _create_field(tx, get_table(tx.conn, tx.domain_id, t), nf)))
        else:
            _plan_field(table, old, f, steps)
    spec_keys = {f.key for f in spec.fields}
    for f in table.active_fields:
        if f.key not in spec_keys:
            steps.append(Step("archive_field", table.name, "spec 里没有这个字段，将归档（数据保留，可恢复）", field=f.key,
                              destructive=True, run=lambda tx, fid=f.id: tx.execute("UPDATE dt_fields SET archived = 1 WHERE id = ?", (fid,))))
    order = [f.key for f in spec.fields]
    if order != [f.key for f in table.active_fields if f.key in spec_keys]:
        steps.append(Step("reorder_fields", table.name, "调整字段顺序：" + "、".join(order),
                          run=lambda tx, t=table.name, o=order: _reorder(tx, get_table(tx.conn, tx.domain_id, t), o)))
    spec_children = {c.name for c in spec.children}
    for name in table.children:
        if name not in spec_children:
            steps.append(Step("keep_child", name, f"子表不在 spec 里，保持不变；要删除请用 dt table drop {name} --force"))


def _plan_field(table: Table, old: Field, new: Field, steps: list):
    new.options = fill_colors(new.options, old.options)
    changes, destructive, conv = [], False, False
    if old.archived:
        changes.append("恢复已归档字段")
    if old.type != new.type:
        changes.append(f"类型 {old.type} → {new.type}，已有值会尽量转换，转换不了的清空")
        destructive = conv = True
    elif new.options is not None:
        removed = [v for v in old.option_values() if v not in new.option_values()]
        added = [v for v in new.option_values() if v not in old.option_values()]
        if removed:
            changes.append(f"删除选项 {removed}，使用这些选项的值会被清空")
            destructive = conv = True
        if added:
            changes.append(f"新增选项 {added}")
        if not removed and not added and new.options != old.options:
            changes.append("调整选项颜色或顺序")
    if old.type == new.type and new.config != old.config:
        if new.type == "link" and new.config["table"] != old.config["table"]:
            changes.append(f"引用表 {old.config['table']} → {new.config['table']}，已有值会被清空")
            destructive = conv = True
        if old.is_array != new.is_array:
            if old.is_array:
                changes.append("改为单值，多个值只保留第一个")
                destructive = True
            else:
                changes.append("改为多值")
            conv = True
        if old.config.get("accept") != new.config.get("accept"):
            changes.append(f"accept: {old.config.get('accept')} → {new.config.get('accept')}（不影响已有附件）")
        if old.config.get("match") != new.config.get("match"):
            changes.append(f"同值关联 match: {old.config.get('match')} → {new.config.get('match')}（图谱的边随之重算，不改数据）")
        if bool(old.config.get("self")) != bool(new.config.get("self")):
            changes.append(f"同字段同值关联 self: {bool(old.config.get('self'))} → {bool(new.config.get('self'))}（图谱的边随之重算，不改数据）")
    for attr in ("label", "description", "default", "required", "unique"):
        if getattr(old, attr) != getattr(new, attr):
            changes.append(f"{attr}: {getattr(old, attr)!r} → {getattr(new, attr)!r}")
    if changes:
        op = "restore_field" if old.archived else "update_field"
        steps.append(Step(op, table.name, "；".join(changes), field=new.key, destructive=destructive,
                          run=lambda tx, t=table.name, o=old, n=new, c=conv: _alter_field(tx, get_table(tx.conn, tx.domain_id, t), o, n, c)))


# ---------- 执行 ----------

def _create_table(tx: Tx, spec: TableSpec, parent: str | None):
    parent_id = get_table(tx.conn, tx.domain_id, parent).id if parent else None
    tx.execute(
        "INSERT INTO dt_tables (domain_id, name, label, description, parent_id, relation, on_delete, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (tx.domain_id, spec.name, spec.label, spec.description, parent_id, spec.relation, spec.on_delete, tx.ts, tx.ts),
    )
    table = get_table(tx.conn, tx.domain_id, spec.name)
    for f in spec.fields:
        _create_field(tx, table, f)


def _field_row(f: Field) -> tuple:
    return (f.key, f.label, f.description, f.type, int(f.required), int(f.unique),
            None if f.default is None else dumps(f.default),
            None if f.options is None else dumps(f.options), dumps(f.config))


def _create_field(tx: Tx, table: Table, f: Field):
    f.options = fill_colors(f.options)
    position = tx.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM dt_fields WHERE table_id = ?", (table.id,)).fetchone()[0]
    tx.execute(
        "INSERT INTO dt_fields (key, label, description, type, required, uniq, default_value, options, config, table_id, position)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (*_field_row(f), table.id, position),
    )
    table = get_table(tx.conn, table.domain_id, table.name)
    if f.type == "auto_number":
        _fill_numbers(tx, table, f.key)
    elif f.default is not None:
        for row in _rows(tx, table):
            data = json.loads(row["data"])
            if data.get(f.key) is None:
                write_data(tx, table, row, {**data, f.key: f.default})


def _rows(tx: Tx, table: Table):
    return tx.execute("SELECT * FROM dt_records WHERE table_id = ? ORDER BY id", (table.id,)).fetchall()


def _fill_numbers(tx: Tx, table: Table, key: str):
    """给还没有编号的记录按 id 顺序补编号，并把计数器推到最大值。"""
    rows = _rows(tx, table)
    datas = [json.loads(r["data"]) for r in rows]
    counter = tx.execute("SELECT value FROM dt_counters WHERE table_id = ? AND field_key = ?", (table.id, key)).fetchone()
    n = max([counter[0] if counter else 0] + [d[key] for d in datas if isinstance(d.get(key), int)])
    for row, data in zip(rows, datas):
        if not isinstance(data.get(key), int):
            n += 1
            write_data(tx, table, row, {**data, key: n})
    tx.execute(
        "INSERT INTO dt_counters (table_id, field_key, value) VALUES (?, ?, ?)"
        " ON CONFLICT (table_id, field_key) DO UPDATE SET value = excluded.value",
        (table.id, key, n),
    )


def _alter_field(tx: Tx, table: Table, old: Field, new: Field, conv: bool):
    tx.execute(
        "UPDATE dt_fields SET key = ?, label = ?, description = ?, type = ?, required = ?, uniq = ?,"
        " default_value = ?, options = ?, config = ?, archived = 0 WHERE id = ?",
        (*_field_row(new), old.id),
    )
    table = get_table(tx.conn, table.domain_id, table.name)
    if conv:
        relinked = new.type == old.type == "link" and new.config["table"] != old.config["table"]
        for row in _rows(tx, table):
            data = json.loads(row["data"])
            value = data.get(new.key)
            if value is None or new.type == "auto_number":
                continue
            value = None if relinked else convert(old, new, value, conn=tx.conn, domain_id=tx.domain_id, actor=tx.actor, ts=tx.ts)
            data = {k: v for k, v in {**data, new.key: value}.items() if v is not None}
            write_data(tx, table, row, data)
    if new.type == "auto_number":
        _fill_numbers(tx, table, new.key)
    if new.unique:
        dup = tx.execute(
            f"SELECT json_extract(data, '$.{new.key}') v, COUNT(*) n FROM dt_records WHERE table_id = ?"
            " GROUP BY v HAVING v IS NOT NULL AND n > 1 LIMIT 5",
            (table.id,),
        ).fetchall()
        if dup:
            raise DtError("unique_violation", f"字段 {table.name}.{new.key} 已有重复值 {[r['v'] for r in dup]}，不能设为 unique",
                          "先处理重复数据再设置 unique", status=409)


def _update_table(tx: Tx, table: Table, spec: TableSpec):
    if table.relation != spec.relation and spec.relation == "one_to_one":
        row = tx.execute(
            "SELECT parent_id, COUNT(*) n FROM dt_records WHERE table_id = ? GROUP BY parent_id HAVING n > 1 LIMIT 1",
            (table.id,),
        ).fetchone()
        if row:
            raise DtError("not_allowed", f"{table.parent} 记录 {row['parent_id']} 有 {row['n']} 条 {table.name}，不能改成一对一",
                          "先删掉多余的子记录")
    tx.execute(
        "UPDATE dt_tables SET label = ?, description = ?, relation = ?, on_delete = ? WHERE id = ?",
        (spec.label, spec.description, spec.relation if table.parent else table.relation,
         spec.on_delete if table.parent else table.on_delete, table.id),
    )


def _reorder(tx: Tx, table: Table, order: list[str]):
    rest = [f.key for f in table.fields if f.key not in order]
    for i, key in enumerate(order + rest):
        tx.execute("UPDATE dt_fields SET position = ? WHERE table_id = ? AND key = ?", (i, table.id, key))


def _touch(tx: Tx, names, created=()):
    for name in dict.fromkeys(names):
        if name not in created:
            tx.execute("UPDATE dt_tables SET schema_version = schema_version + 1, updated_at = ? WHERE domain_id = ? AND name = ?",
                       (tx.ts, tx.domain_id, name))
        table = get_table(tx.conn, tx.domain_id, name)
        tx.log(name, None, "create_table" if name in created else "alter_table", None, table_to_dict(tx.conn, table, tree=False))


def _execute(tx: Tx, steps: list[Step], force: bool):
    destructive = [s.to_dict() for s in steps if s.destructive]
    if destructive and not force:
        raise DtError("destructive_change", f"计划里有 {len(destructive)} 项破坏性变更，未执行",
                      "确认这些变更后加 --force 重新执行", status=409, details={"plan": [s.to_dict() for s in steps]})
    runnable = [s for s in steps if s.run]
    for s in runnable:
        s.run(tx)
    tables = [s.table for s in runnable if s.op not in ("create_domain", "update_domain")]
    _touch(tx, tables, created={s.table for s in runnable if s.op == "create_table"})


def apply(db, domain: str, raw, *, dry_run: bool = False, force: bool = False, actor: str = "cli") -> dict:
    spec = parse_spec(raw)
    if dry_run:
        with db.read() as conn:
            steps = plan(conn, get_domain(conn, domain)["id"], [spec])
        return {"applied": False, "plan": [s.to_dict() for s in steps], "warnings": spec_warnings([spec])}
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        steps = plan(tx.conn, tx.domain_id, [spec])
        _execute(tx, steps, force)
        schema = table_to_dict(tx.conn, get_table(tx.conn, tx.domain_id, spec.name))
    return {"applied": True, "plan": [s.to_dict() for s in steps], "schema": schema, "warnings": spec_warnings([spec])}


def add_field(db, domain: str, table_name: str, raw, *, actor: str = "cli") -> dict:
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        table = get_table(tx.conn, tx.domain_id, table_name)
        f = parse_field(raw, table_name)
        existing = next((x for x in table.fields if x.key == f.key), None)
        if existing is not None:
            hint = "该字段已归档，在 spec 里重新写上它并 dt table apply 即可恢复" if existing.archived else "换一个 key，或用 dt table apply 修改字段"
            raise DtError("already_exists", f"表 {table_name} 已有字段 {f.key}", hint, status=409)
        if f.key in table.children:
            raise _err(f"字段 {f.key} 和子表重名")
        if f.type == "link":
            get_table(tx.conn, tx.domain_id, f.config["table"])
        _create_field(tx, table, f)
        _touch(tx, [table_name])
        return field_to_dict(get_table(tx.conn, tx.domain_id, table_name).field(f.key))


def _subtree(conn, table: Table, acc: list) -> list:
    for name in table.children:
        _subtree(conn, get_table(conn, table.domain_id, name), acc)
    acc.append(table)
    return acc


def drop_table(db, domain: str, name: str, *, force: bool = False, actor: str = "cli") -> dict:
    with db.tx(actor) as tx:
        bind_domain(tx, domain)
        tables = _subtree(tx.conn, get_table(tx.conn, tx.domain_id, name), [])
        names = {t.name for t in tables}
        counts = {t.name: tx.execute("SELECT COUNT(*) FROM dt_records WHERE table_id = ?", (t.id,)).fetchone()[0] for t in tables}
        if not force:
            raise DtError("destructive_change", f"将删除表 {sorted(names)} 和其中 {sum(counts.values())} 条记录，未执行",
                          "确认后加 --force", status=409, details={"tables": counts})
        refs = [f"{t.name}.{f.key}" for t in list_tables(tx.conn, tx.domain_id) if t.name not in names
                for f in t.active_fields if f.type == "link" and f.config["table"] in names]
        if refs:
            raise DtError("not_allowed", f"字段 {refs} 引用了要删除的表", "先在这些表的 spec 里去掉对应 link 字段并 apply")
        delete_tables(tx, tables, counts)
    return {"dropped": counts}


def delete_tables(tx: Tx, tables: list[Table], counts: dict):
    """tables 要求子表在父表前面（_subtree 的顺序）。"""
    for t in tables:
        tx.execute("DELETE FROM dt_records WHERE table_id = ?", (t.id,))
        tx.execute("DELETE FROM dt_counters WHERE table_id = ?", (t.id,))
        tx.execute("DELETE FROM dt_fields WHERE table_id = ?", (t.id,))
        tx.execute("DELETE FROM dt_tables WHERE id = ?", (t.id,))
        tx.log(t.name, None, "drop_table", {"record_count": counts[t.name]}, None)
