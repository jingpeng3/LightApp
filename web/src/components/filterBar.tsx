import { Bookmark, Check, ListFilter, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Facet, Field, SavedView, TableInfo } from "../api";
import { api } from "../api";
import {
  compileWhere, condWhere, DATE_PRESETS, EMPTY_QUERY, FACET_TYPES, filterFields, isFiltering,
  type Cond, type TableQuery,
} from "../filters";
import { actorName, asList, cx, fieldLabel, toast, toastError } from "../util";
import { optionColor } from "./cells";
import { LinkPicker } from "./editors";
import { Popover, Tag, TypeGlyph, useApp } from "./ui";

type Kind = "options" | "checkbox" | "text" | "number" | "date" | "link" | "attachment";

function kindOf(f: Field): Kind {
  if (f.type === "checkbox") return "checkbox";
  if (FACET_TYPES.includes(f.type)) return "options";
  if (f.type === "number" || f.type === "auto_number") return "number";
  if (f.type === "date" || f.type === "datetime") return "date";
  if (f.type === "link") return "link";
  if (f.type === "attachment") return "attachment";
  return "text";
}

const FIRST_OP: Record<Kind, Cond> = {
  options: { key: "", op: "in", value: [] },
  checkbox: { key: "", op: "eq", value: true },
  text: { key: "", op: "contains", value: "" },
  number: { key: "", op: "range", value: [null, null] },
  date: { key: "", op: "date", value: null },
  link: { key: "", op: "in", value: [] },
  attachment: { key: "", op: "not_empty" },
};

const MODES: Record<Kind, Cond["op"][]> = {
  options: ["in", "nin", "empty", "not_empty"],
  checkbox: ["eq"],
  text: ["contains", "empty", "not_empty"],
  number: ["range", "empty", "not_empty"],
  date: ["date", "empty", "not_empty"],
  link: ["in", "empty", "not_empty"],
  attachment: ["not_empty", "empty"],
};

function modeLabel(f: Field, op: Cond["op"]) {
  const multi = f.type === "multi_select" || (f.type === "link" && f.config?.multiple);
  return {
    in: multi ? "包含任一" : "是", nin: multi ? "都不包含" : "不是", contains: "包含", eq: "是",
    range: "范围", date: "日期", empty: "为空", not_empty: "不为空",
  }[op];
}

const short = (d: string) => d.slice(5);

/** 条件在标签上的文字，如「状态 是 待办、进行中」「截止 早于今天」。 */
function condText(f: Field, c: Cond): string {
  const v = c.value;
  const name = fieldLabel(f);
  switch (c.op) {
    case "empty":
    case "not_empty":
      return `${name} ${modeLabel(f, c.op)}`;
    case "in":
    case "nin": {
      const list = asList<unknown>(v).map((x) => (f.type === "link" ? `#${x}` : f.type === "person" ? actorName(String(x)) : String(x)));
      return `${name} ${modeLabel(f, c.op)} ${list.length ? list.slice(0, 3).join("、") + (list.length > 3 ? ` 等 ${list.length} 个` : "") : "…"}`;
    }
    case "contains":
      return `${name} 包含 ${v ? `“${v}”` : "…"}`;
    case "eq":
      return `${name} ${v ? "是" : "否"}`;
    case "range": {
      const [a, b] = (v as [number | null, number | null]) ?? [];
      return `${name} ${a != null && b != null ? `${a} ~ ${b}` : a != null ? `≥ ${a}` : b != null ? `≤ ${b}` : "…"}`;
    }
    case "date": {
      if (typeof v === "string") return `${name} ${DATE_PRESETS.find((p) => p.id === v)?.label ?? v}`;
      const [a, b] = (v as [string | null, string | null]) ?? [];
      return `${name} ${a && b ? `${short(a)} ~ ${short(b)}` : a ? `${short(a)} 起` : b ? `到 ${short(b)}` : "…"}`;
    }
  }
}

/** 表头下面的一行：视图、筛选条件标签、加条件、存为视图、清除。 */
export function FilterBar({ table, query, setQuery, views, onSaved }: {
  table: TableInfo;
  query: TableQuery;
  setQuery: (q: Partial<TableQuery> | ((q: TableQuery) => TableQuery)) => void;
  views: SavedView[];
  onSaved: () => void;
}) {
  const { byName } = useApp();
  const fields = filterFields(table);
  const [editing, setEditing] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const view = query.view ? views.find((v) => v.table === table.name && v.name === query.view) : undefined;

  // 新加的条件要等标签渲染出来，才能把编辑浮层挂上去
  useLayoutEffect(() => {
    setAnchor(editing == null ? null : barRef.current?.querySelector<HTMLElement>(`[data-chip="${editing}"]`) ?? null);
  }, [editing, query.filters.length]);

  const update = (i: number, c: Cond) => setQuery((q) => ({ ...q, filters: q.filters.map((x, j) => (j === i ? c : x)) }));
  const remove = (i: number) => setQuery((q) => ({ ...q, filters: q.filters.filter((_, j) => j !== i) }));
  const add = (f: Field) => {
    setPicking(false);
    setQuery((q) => ({ ...q, filters: [...q.filters, { ...FIRST_OP[kindOf(f)], key: f.key }] }));
    setEditing(query.filters.length);
  };
  // 关掉编辑浮层时，没填完的条件直接去掉
  const close = () => {
    const c = editing != null ? query.filters[editing] : undefined;
    const f = c && fields.find((x) => x.key === c.key);
    if (c && (!f || !condWhere(f, c))) remove(editing!);
    setEditing(null);
  };

  const editCond = editing != null ? query.filters[editing] : undefined;
  const editField = editCond && fields.find((x) => x.key === editCond.key);

  return (
    <div ref={barRef} className="flex min-h-9 flex-wrap items-center gap-1.5 px-6 pb-2.5">
      {query.view && (
        <span className="inline-flex h-7 items-center gap-1 rounded-md bg-ink pr-1 pl-2 text-[12px] text-surface" title={view?.description ?? undefined}>
          <Bookmark size={12} />
          {query.view}
          {!view && <span className="text-[11px] opacity-70">（已删除）</span>}
          <button type="button" title="退出视图" onClick={() => setQuery({ view: null, sort: null })} className="flex size-5 items-center justify-center rounded opacity-70 hover:opacity-100">
            <X size={12} />
          </button>
        </span>
      )}
      {query.filters.map((c, i) => {
        const f = fields.find((x) => x.key === c.key);
        return (
          <span
            key={i}
            data-chip={i}
            className={cx(
              "inline-flex h-7 max-w-[320px] items-center rounded-md border bg-surface text-[12px]",
              editing === i ? "border-accent" : "border-line-strong",
              !f && "opacity-50",
            )}
          >
            <button type="button" onClick={() => f && setEditing(i)} className="flex min-w-0 items-center gap-1 pr-1 pl-2" title={f ? undefined : `字段 ${c.key} 已不存在，这个条件不起作用`}>
              {f && <TypeGlyph type={f.type} />}
              <span className="truncate">{f ? condText(f, c) : c.key}</span>
            </button>
            <button type="button" title="去掉这个条件" onClick={() => remove(i)} className="flex h-full items-center pr-1.5 pl-0.5 text-ink-3 hover:text-danger">
              <X size={12} />
            </button>
          </span>
        );
      })}
      <button
        ref={addRef}
        type="button"
        onClick={() => setPicking(true)}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-3 hover:bg-raise hover:text-ink"
      >
        {query.filters.length ? <Plus size={13} /> : <ListFilter size={13} />} {query.filters.length ? "条件" : "筛选"}
      </button>
      {isFiltering(query) && (
        <span className="ml-auto flex items-center gap-1">
          <button
            ref={saveRef}
            type="button"
            onClick={() => setSaving(true)}
            disabled={!compileWhere(table, byName, query) && !query.view && !query.sort}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-2 hover:bg-raise hover:text-ink disabled:opacity-40"
          >
            <Bookmark size={12} /> {query.view && view ? "更新视图" : "存为视图"}
          </button>
          <button type="button" onClick={() => setQuery(EMPTY_QUERY)} className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-ink-3 hover:bg-raise hover:text-ink">
            清除
          </button>
        </span>
      )}
      {picking && <FieldPicker fields={fields} anchor={addRef.current} onPick={add} onClose={() => setPicking(false)} />}
      {editCond && editField && anchor && (
        <Popover anchor={anchor} onClose={close} width={editField.type === "link" ? 300 : 260}>
          <CondEditor table={table} field={editField} cond={editCond} index={editing!} query={query} view={view?.name ?? null} onChange={(c) => update(editing!, c)} />
        </Popover>
      )}
      {saving && <SaveView table={table} query={query} view={view} anchor={saveRef.current} onClose={() => setSaving(false)} onSaved={(name) => (setSaving(false), onSaved(), setQuery({ ...EMPTY_QUERY, view: name }))} />}
    </div>
  );
}

function FieldPicker({ fields, anchor, onPick, onClose }: { fields: Field[]; anchor: HTMLElement | null; onPick: (f: Field) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const shown = fields.filter((f) => `${fieldLabel(f)} ${f.key}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} width={240}>
      <div className="p-1">
        <input
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setActive(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, shown.length - 1));
            if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            if (e.key === "Enter" && !e.nativeEvent.isComposing && shown[active]) onPick(shown[active]);
          }}
          placeholder="按哪个字段筛选"
          className="mb-1 h-7 w-full rounded-md bg-raise px-2 outline-none"
        />
        {shown.map((f, i) => (
          <button
            key={f.key}
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(f)}
            className={cx("flex h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left", i === active && "bg-raise", f.key.startsWith("_") && "text-ink-2")}
          >
            <TypeGlyph type={f.type} />
            <span className="truncate">{fieldLabel(f)}</span>
            <span className="ml-auto font-mono text-[10.5px] text-ink-3">{f.key}</span>
          </button>
        ))}
        {!shown.length && <div className="px-2 py-3 text-ink-3">没有匹配的字段</div>}
      </div>
    </Popover>
  );
}

const segBtn = (on: boolean) => cx("h-6 rounded px-2 text-[12px]", on ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-3 hover:text-ink");

/** 一个条件的编辑浮层：顶部切换方式（是 / 不是 / 为空…），下面按字段类型给输入方式。 */
function CondEditor({ table, field: f, cond: c, index, query, view, onChange }: {
  table: TableInfo;
  field: Field;
  cond: Cond;
  index: number;
  query: TableQuery;
  view: string | null; // 只传还存在的视图
  onChange: (c: Cond) => void;
}) {
  const { byName } = useApp();
  const kind = kindOf(f);
  const modes = MODES[kind];
  const [facet, setFacet] = useState<(Facet & { total: number }) | null>(null);
  // 计数按「其他条件都满足」来算，选了这个值大概会剩多少条一目了然
  const others = JSON.stringify(compileWhere(table, byName, query, index));
  useEffect(() => {
    if (!FACET_TYPES.includes(f.type)) return;
    api.facets(table.name, { fields: [f.key], where: JSON.parse(others), view }).then((r) => setFacet({ ...r.fields[f.key], total: r.total }), toastError);
  }, [table.name, f.key, f.type, others, view]);
  const count = (v: unknown) => facet?.values.find((x) => x.value === v)?.count ?? 0;

  const setOp = (op: Cond["op"]) => {
    if (op === c.op) return;
    const keep = (op === "in" || op === "nin") && (c.op === "in" || c.op === "nin");
    onChange({ key: c.key, op, value: keep ? c.value : FIRST_OP[kind].op === op ? FIRST_OP[kind].value : undefined });
  };

  return (
    <div className="p-1.5">
      {modes.length > 1 && (
        <div className="mb-1.5 flex gap-0.5 rounded-md bg-raise p-0.5">
          {modes.map((op) => <button key={op} type="button" onClick={() => setOp(op)} className={segBtn(c.op === op)}>{modeLabel(f, op)}</button>)}
        </div>
      )}
      {(c.op === "empty" || c.op === "not_empty") && (
        <div className="px-1.5 py-1 text-[12px] text-ink-3">
          {c.op === "empty" ? "没有填写" : "填写了"}{fieldLabel(f)}的记录{facet && `（${c.op === "empty" ? facet.empty : facet.total - facet.empty} 条）`}
        </div>
      )}
      {kind === "checkbox" && (
        <div className="flex flex-col">
          {[true, false].map((v) => (
            <button key={String(v)} type="button" onClick={() => onChange({ ...c, value: v })} className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-raise">
              <span className="flex size-[14px] items-center justify-center rounded-full">{c.value === v && <Check size={13} className="text-accent" strokeWidth={2.5} />}</span>
              {v ? "是" : "否"}
              <span className="ml-auto font-mono text-[11px] text-ink-3">{count(v)}</span>
            </button>
          ))}
        </div>
      )}
      {kind === "options" && (c.op === "in" || c.op === "nin") && <ValueList field={f} facet={facet} cond={c} onChange={onChange} />}
      {kind === "text" && c.op === "contains" && (
        <input
          autoFocus
          value={String(c.value ?? "")}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
          placeholder="包含的文字，不区分大小写"
          className="h-8 w-full rounded-md bg-raise px-2 outline-none"
        />
      )}
      {kind === "number" && c.op === "range" && <RangeInput cond={c} onChange={onChange} />}
      {kind === "date" && c.op === "date" && <DateInput cond={c} onChange={onChange} />}
      {kind === "link" && c.op === "in" && (
        <LinkPicker
          field={{ ...f, config: { ...f.config, multiple: true } }}
          value={asList<number>(c.value)}
          onCommit={(v) => onChange({ ...c, value: v })}
          onClose={() => {}}
        />
      )}
    </div>
  );
}

/** 可选的值：单选、多选用字段的选项；人员字段和系统字段没有固定选项，用统计出来的值。 */
function ValueList({ field: f, facet, cond: c, onChange }: { field: Field; facet: Facet | null; cond: Cond; onChange: (c: Cond) => void }) {
  const [q, setQ] = useState("");
  const selected = asList<string>(c.value);
  const counted = (facet?.values ?? []).map((x) => String(x.value));
  // 已选的值即使当前统计里没有（比如被别的条件筛掉了）也要列出来，才能取消
  const all = f.options?.length ? f.options.map((o) => o.value) : [...new Set([...selected, ...counted])];
  const shown = all.filter((v) => v.toLowerCase().includes(q.toLowerCase()));
  const count = (v: string) => facet?.values.find((x) => x.value === v)?.count ?? 0;
  const toggle = (v: string) => onChange({ ...c, value: selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v] });
  return (
    <div>
      {all.length > 6 && (
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选取值" className="mb-1 h-7 w-full rounded-md bg-raise px-2 outline-none" />
      )}
      <div className="max-h-64 overflow-auto">
        {shown.map((v) => (
          <button key={v} type="button" onClick={() => toggle(v)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-raise">
            <span className="flex size-[14px] shrink-0 items-center justify-center rounded-[3px] border border-line-strong">
              {selected.includes(v) && <Check size={11} className="text-accent" strokeWidth={3} />}
            </span>
            {f.options?.length ? <Tag value={v} color={optionColor(f, v)} /> : <span className="truncate">{f.type === "person" ? actorName(v) : v}</span>}
            <span className={cx("ml-auto font-mono text-[11px]", count(v) ? "text-ink-3" : "text-ink-3/50")}>{facet ? count(v) : ""}</span>
          </button>
        ))}
        {!shown.length && <div className="px-2 py-3 text-ink-3">{facet ? "没有可选的值" : "统计中…"}</div>}
      </div>
    </div>
  );
}

function NumberBox({ value, onChange, placeholder }: { value: number | null; onChange: (v: number | null) => void; placeholder: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  return (
    <input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onChange(e.target.value.trim() && Number.isFinite(n) ? n : null);
      }}
      placeholder={placeholder}
      className="h-8 w-full min-w-0 rounded-md bg-raise px-2 text-right font-mono outline-none"
    />
  );
}

function RangeInput({ cond: c, onChange }: { cond: Cond; onChange: (c: Cond) => void }) {
  const [a, b] = (c.value as [number | null, number | null]) ?? [null, null];
  return (
    <div className="flex items-center gap-1.5 p-0.5">
      <NumberBox value={a} placeholder="最小" onChange={(v) => onChange({ ...c, value: [v, b] })} />
      <span className="text-ink-3">~</span>
      <NumberBox value={b} placeholder="最大" onChange={(v) => onChange({ ...c, value: [a, v] })} />
    </div>
  );
}

function DateInput({ cond: c, onChange }: { cond: Cond; onChange: (c: Cond) => void }) {
  const preset = typeof c.value === "string" ? c.value : null;
  const [a, b] = Array.isArray(c.value) ? (c.value as [string | null, string | null]) : [null, null];
  return (
    <div>
      <div className="grid grid-cols-2 gap-0.5">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange({ ...c, value: p.id })}
            className={cx("h-7 rounded-md px-2 text-left text-[12px]", preset === p.id ? "bg-accent-soft text-accent" : "hover:bg-raise")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 border-t border-line pt-1.5">
        <div className="mb-1 px-1 text-[11px] text-ink-3">自定义区间（含首尾两天）</div>
        <div className="flex items-center gap-1">
          <input type="date" value={a ?? ""} onChange={(e) => onChange({ ...c, value: [e.target.value || null, b] })} className="h-7 min-w-0 flex-1 rounded-md bg-raise px-1.5 font-mono text-[11.5px] outline-none" />
          <span className="text-ink-3">~</span>
          <input type="date" value={b ?? ""} onChange={(e) => onChange({ ...c, value: [a, e.target.value || null] })} className="h-7 min-w-0 flex-1 rounded-md bg-raise px-1.5 font-mono text-[11.5px] outline-none" />
        </div>
      </div>
    </div>
  );
}

/** 把当前的视图 + 筛选 + 搜索 + 排序存成一个命名视图。在视图上继续加了条件时，默认是更新这个视图。 */
function SaveView({ table, query, view, anchor, onClose, onSaved }: {
  table: TableInfo;
  query: TableQuery;
  view: SavedView | undefined;
  anchor: HTMLElement | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { byName } = useApp();
  const [name, setName] = useState(view?.name ?? "");
  const [busy, setBusy] = useState(false);
  const extra = compileWhere(table, byName, query);
  // 视图的条件和当前额外的条件合在一起存
  const where = [view?.where, extra].filter(Boolean) as Record<string, unknown>[];
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.saveView({
        table: table.name, name: name.trim(),
        where: !where.length ? null : where.length === 1 ? where[0] : { $and: where },
        sort: query.sort ?? view?.sort ?? null,
      });
      toast("info", `已保存视图「${name.trim()}」`, `agent 可以用 dt rec query ${table.name} --view ${name.trim()} 复用`);
      onSaved(name.trim());
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} align="end">
      <div className="p-2.5">
        <div className="mb-1.5 text-[12px] text-ink-2">视图名</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && save()}
          placeholder="如：逾期未完成"
          className="h-8 w-full rounded-md bg-raise px-2 outline-none"
        />
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          {view && name.trim() === view.name ? "会覆盖这个视图的条件。" : "同名视图会被覆盖。"}日期快捷项按相对日期保存，每天自动更新。所有人和 agent 都能用。
        </p>
        <div className="mt-2 flex justify-end">
          <button type="button" disabled={busy || !name.trim()} onClick={save} className="flex h-7 items-center gap-1 rounded-md bg-ink px-2.5 text-surface hover:bg-accent disabled:opacity-40">
            保存
          </button>
        </div>
      </div>
    </Popover>
  );
}
