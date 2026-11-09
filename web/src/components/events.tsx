import {
  Code2, Inbox, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Terminal, Trash2, Webhook, X, Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Binding, BindingAction, Delivery, EventItem, EventOp, TableInfo } from "../api";
import { api } from "../api";
import { onChange } from "../live";
import { actorColor, brief, clock, cx, fieldLabel, relTime, tableLabel, toast, toastError } from "../util";
import { ActorChip, Btn, Empty, useApp } from "./ui";

const OP_LABEL: Record<EventOp, string> = { insert: "新增", update: "变更", delete: "删除" };
const OP_STYLE: Record<EventOp, { bg: string; fg: string }> = {
  insert: { bg: "var(--opt-green-bg)", fg: "var(--opt-green-fg)" },
  update: { bg: "var(--opt-blue-bg)", fg: "var(--opt-blue-fg)" },
  delete: { bg: "var(--opt-red-bg)", fg: "var(--opt-red-fg)" },
};
const ACTION_ICON = { webhook: Webhook, command: Terminal, write: Zap, inbox: Inbox };
const ACTION_LABEL: Record<BindingAction, string> = { webhook: "webhook", command: "command", write: "write", inbox: "inbox" };
const EXAMPLES: Record<BindingAction, string> = {
  webhook: '{\n  "url": "http://127.0.0.1:9000/hook"\n}',
  command: '{\n  "cmd": "cat >> /tmp/dt-events.jsonl"\n}',
  write: '{\n  "table": "task_log",\n  "parent_id": "${event.record_id}",\n  "data": {\n    "content": "任务 ${record.title} 已更新"\n  }\n}',
  inbox: '{\n  "title": "${record.title} 有变化",\n  "body": "${fields.status.before} → ${fields.status.after}"\n}',
};

/** 右侧主视图：记录事件流和绑定管理。 */
export function EventsView() {
  const { domain, tables, byName } = useApp();
  const [view, setView] = useState<"events" | "bindings">("events");
  const [op, setOp] = useState<"" | EventOp>("");
  const [table, setTable] = useState("");
  const [field, setField] = useState("");
  const [items, setItems] = useState<EventItem[] | null>(null);
  const [bindings, setBindings] = useState<Binding[] | null>(null);
  const [editing, setEditing] = useState<Binding | "new" | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[] | null>>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [raw, setRaw] = useState<Set<number>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadEvents = useCallback((quiet = false) => {
    api.events({ limit: 200, op: op || undefined, table: table || undefined, field: field || undefined })
      .then((data) => setItems(data.items.slice().reverse()), quiet ? () => {} : toastError);
  }, [op, table, field]);

  const loadBindings = useCallback(() => api.bindings().then(setBindings, toastError), []);

  useEffect(() => {
    setItems(null);
    loadEvents();
  }, [loadEvents]);
  useEffect(() => {
    loadBindings();
  }, [loadBindings]);
  useEffect(() => {
    const off = onChange(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => loadEvents(true), 250);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [loadEvents]);

  const fields = table ? byName[table]?.fields ?? [] : [];
  const changeTable = (value: string) => {
    setTable(value);
    setField("");
  };

  const toggleEnabled = (binding: Binding) => {
    api.updateBinding(binding.name, { enabled: !binding.enabled })
      .then(() => loadBindings(), toastError);
  };

  const remove = (binding: Binding) => {
    if (!confirm(`删除绑定 ${binding.name}？`)) return;
    api.deleteBinding(binding.name).then(() => {
      toast("info", `已删除绑定 ${binding.name}`);
      if (openDeliveries === binding.name) setOpenDeliveries(null);
      loadBindings();
    }, toastError);
  };

  const showDeliveries = (name: string) => {
    if (openDeliveries === name) return setOpenDeliveries(null);
    setOpenDeliveries(name);
    setDeliveries((prev) => ({ ...prev, [name]: null }));
    api.deliveries(name, { limit: 20 }).then(
      (list) => setDeliveries((prev) => ({ ...prev, [name]: list })),
      toastError,
    );
  };

  const retry = (name: string) => {
    api.retryBinding(name).then((result) => {
      toast("info", `已重新排队 ${result.retried} 条投递`);
      return api.deliveries(name, { limit: 20 }).then((list) => setDeliveries((prev) => ({ ...prev, [name]: list })));
    }, toastError);
  };

  const toggleExpand = (set: Set<number>, update: (next: Set<number>) => void, seq: number) => {
    const next = new Set(set);
    next.has(seq) ? next.delete(seq) : next.add(seq);
    update(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-6 pt-5 pb-0">
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
          <span>{domain}</span>
          <span>/</span>
          <span className="text-ink-2">事件</span>
        </div>
        <div className="mt-1 flex items-end gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[40px] leading-[1.05]">事件</h1>
            <p className="mt-1 text-[12.5px] text-ink-3">记录的新增、变更和删除；可以订阅到字段，命中后执行绑定动作。</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {view === "events" ? (
              <Btn kind="line" onClick={() => loadEvents()} className="h-8"><RefreshCw size={13} /> 刷新</Btn>
            ) : (
              <Btn kind="solid" onClick={() => setEditing("new")} className="h-8 px-3"><Plus size={14} /> 新建绑定</Btn>
            )}
          </div>
        </div>
        <nav className="mt-3 flex gap-4">
          {(["events", "bindings"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setView(tab)}
              className={cx(
                "relative pb-2 text-[12.5px]",
                view === tab
                  ? "text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-accent"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              {tab === "events" ? "事件流" : `绑定${bindings ? ` ${bindings.length}` : ""}`}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 flex-col border-t border-line bg-surface">
        {view === "events" ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
              <span className="text-[11px] text-ink-3">筛选</span>
              <select
                value={op}
                onChange={(e) => setOp(e.target.value as "" | EventOp)}
                className="h-7 rounded-md border border-line-strong bg-surface px-2 outline-none"
              >
                <option value="">全部操作</option>
                <option value="insert">新增</option>
                <option value="update">变更</option>
                <option value="delete">删除</option>
              </select>
              <select
                value={table}
                onChange={(e) => changeTable(e.target.value)}
                className="h-7 max-w-[220px] rounded-md border border-line-strong bg-surface px-2 outline-none"
              >
                <option value="">全部表</option>
                {tables.map((t) => <option key={t.name} value={t.name}>{tableLabel(t, t.name)}（{t.name}）</option>)}
              </select>
              <select
                value={field}
                onChange={(e) => setField(e.target.value)}
                disabled={!table}
                className="h-7 max-w-[200px] rounded-md border border-line-strong bg-surface px-2 outline-none disabled:opacity-40"
              >
                <option value="">任意字段</option>
                {fields.map((f) => <option key={f.key} value={f.key}>{fieldLabel(f)}（{f.key}）</option>)}
              </select>
              <span className="ml-auto font-mono text-[10.5px] text-ink-3">
                {items === null ? "读取中…" : `最近 ${items.length} 条`}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {items === null ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-16 animate-pulse rounded bg-raise" />)}
                </div>
              ) : !items.length ? (
                <Empty title="还没有事件">
                  让 agent 或人改一条记录，事件会立刻出现在这里。表结构变更不算记录事件。
                </Empty>
              ) : (
                items.map((event) => (
                  <EventRow
                    key={event.seq}
                    event={event}
                    table={byName[event.table]}
                    expanded={expanded.has(event.seq)}
                    raw={raw.has(event.seq)}
                    onExpand={() => toggleExpand(expanded, setExpanded, event.seq)}
                    onRaw={() => toggleExpand(raw, setRaw, event.seq)}
                  />
                ))
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {bindings === null ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-raise" />)}
              </div>
            ) : !bindings.length ? (
              <Empty title="还没有绑定">
                绑定监听记录事件，命中后执行 webhook、本机命令或写回记录。点右上角「新建绑定」开始。
              </Empty>
            ) : (
              <div className="mx-auto max-w-[880px] space-y-3">
                {bindings.map((binding) => (
                  <BindingCard
                    key={binding.name}
                    binding={binding}
                    tables={tables}
                    open={openDeliveries === binding.name}
                    deliveries={deliveries[binding.name]}
                    onToggle={() => toggleEnabled(binding)}
                    onEdit={() => setEditing(binding)}
                    onDelete={() => remove(binding)}
                    onDeliveries={() => showDeliveries(binding.name)}
                    onRetry={() => retry(binding.name)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <BindingForm
          key={editing === "new" ? "new" : editing.name}
          binding={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadBindings();
          }}
        />
      )}
    </div>
  );
}

function EventRow({ event, table, expanded, raw, onExpand, onRaw }: {
  event: EventItem;
  table: TableInfo | undefined;
  expanded: boolean;
  raw: boolean;
  onExpand: () => void;
  onRaw: () => void;
}) {
  const { openRecord } = useApp();
  const entries = Object.entries(event.fields);
  const shown = expanded ? entries : entries.slice(0, 6);
  const style = OP_STYLE[event.op];
  return (
    <article className="border-b border-line px-5 py-3.5 hover:bg-[color-mix(in_oklab,var(--raise)_50%,var(--surface))]">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-[19px] items-center rounded-[4px] px-1.5 text-[11px]" style={{ background: style.bg, color: style.fg }}>
          {OP_LABEL[event.op]}
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">#{event.seq}</span>
        <span className="text-[12.5px] text-ink-2">{tableLabel(table, event.table)}</span>
        {event.op === "delete" ? (
          <span className="font-mono text-[11.5px] text-ink-3">#{event.record_id}</span>
        ) : (
          <button
            type="button"
            onClick={() => openRecord({ table: event.table, id: event.record_id })}
            className="font-mono text-[11.5px] text-ink-3 hover:text-accent"
          >
            #{event.record_id}
          </button>
        )}
        <ActorChip actor={event.actor} small />
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3" title={clock(event.ts)}>{relTime(event.ts)}</span>
        <button type="button" onClick={onRaw} title={raw ? "收起 JSON" : "查看原始 JSON"} className={cx("rounded p-1 hover:bg-raise", raw ? "text-accent" : "text-ink-3 hover:text-ink")}>
          <Code2 size={12} />
        </button>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {shown.map(([key, diff]) => {
          const f = table?.fields.find((x) => x.key === key);
          return (
            <div key={key} className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
              <span className="w-[120px] shrink-0 truncate text-ink-3" title={key}>{f ? fieldLabel(f) : key}</span>
              <span className="max-w-[38%] shrink truncate text-ink-3 line-through decoration-ink-3/40">{brief(f, diff.before)}</span>
              <span className="shrink-0 text-ink-3">→</span>
              <span className="min-w-0 truncate font-medium">{brief(f, diff.after)}</span>
            </div>
          );
        })}
        {!entries.length && <div className="text-[12px] text-ink-3">没有用户字段变化</div>}
        {entries.length > 6 && (
          <button type="button" onClick={onExpand} className="text-[11.5px] text-ink-3 hover:text-accent">
            {expanded ? "收起字段" : `另外 ${entries.length - 6} 个字段`}
          </button>
        )}
      </div>
      {raw && (
        <pre className="mt-2 max-h-[300px] overflow-auto rounded-md border border-line bg-raise p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </article>
  );
}

function BindingCard({ binding, tables, open, deliveries, onToggle, onEdit, onDelete, onDeliveries, onRetry }: {
  binding: Binding;
  tables: TableInfo[];
  open: boolean;
  deliveries: Delivery[] | null | undefined;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onDeliveries: () => void;
  onRetry: () => void;
}) {
  const Icon = ACTION_ICON[binding.action];
  const target = binding.table_name
    ? `${tableLabel(tables.find((t) => t.name === binding.table_name), binding.table_name)}${binding.field ? `.${binding.field}` : ""}`
    : "整个域";
  const failed = deliveries?.some((d) => d.status === "failed");
  return (
    <article className={cx("rounded-lg border bg-surface p-3.5", binding.enabled ? "border-line" : "border-dashed border-line-strong opacity-70")}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-[13.5px]">{binding.name}</span>
        <span className="inline-flex items-center gap-1 rounded-[4px] border border-line-strong px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
          <Icon size={11} /> {ACTION_LABEL[binding.action]}
        </span>
        <span className="rounded-[4px] bg-raise px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3">{binding.ops.join(",")}</span>
        {!binding.enabled && <span className="text-[11px] text-ink-3">已停用</span>}
        <span className="ml-auto flex items-center gap-1">
          <Btn onClick={onToggle} title={binding.enabled ? "停用" : "启用"}>{binding.enabled ? <Pause size={13} /> : <Play size={13} />}</Btn>
          <Btn onClick={onEdit} title="编辑绑定"><Pencil size={13} /></Btn>
          <Btn kind="danger" onClick={onDelete} title="删除绑定"><Trash2 size={13} /></Btn>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-3">
        <span>{target}</span>
        {binding.where && <span title={JSON.stringify(binding.where)}>where {compactJson(binding.where)}</span>}
        {binding.where_before && <span title={JSON.stringify(binding.where_before)}>before {compactJson(binding.where_before)}</span>}
      </div>
      <div className="mt-1.5 truncate rounded-md bg-raise px-2 py-1 font-mono text-[11px] text-ink-2" title={JSON.stringify(binding.config)}>
        {binding.action === "webhook"
          ? String(binding.config.url ?? "")
          : binding.action === "inbox"
            ? String(binding.config.title ?? "默认摘要")
            : compactJson(binding.config)}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onDeliveries}
          className={cx("inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px]", open ? "bg-raise text-ink" : "text-ink-2 hover:bg-raise hover:text-ink")}
        >
          <Inbox size={12} /> 投递记录
        </button>
        <span className="font-mono text-[10.5px] text-ink-3">创建 {ActorChipShort(binding.created_by)} {relTime(binding.created_at)}</span>
      </div>
      {open && (
        <div className="mt-2 rounded-md border border-line bg-panel p-2">
          {deliveries === null ? (
            <div className="py-1 text-[11.5px] text-ink-3">读取中…</div>
          ) : !deliveries?.length ? (
            <div className="py-1 text-[11.5px] text-ink-3">还没有投递。事件命中后才会产生。</div>
          ) : (
            <>
              <div className="space-y-1">
                {deliveries.map((delivery) => (
                  <div key={delivery.id} className="flex min-w-0 items-baseline gap-2 text-[11.5px]">
                    <span className={cx("shrink-0 font-mono", delivery.status === "sent" ? "text-ok" : delivery.status === "failed" ? "text-danger" : "text-warn")}>
                      {delivery.status}
                    </span>
                    <span className="shrink-0 font-mono text-ink-3">#{delivery.change_seq}</span>
                    <span className="shrink-0 text-ink-3">{delivery.event_count > 1 ? `${delivery.event_count} 条事件` : "1 条"}</span>
                    <span className="shrink-0 text-ink-3">尝试 {delivery.attempts}</span>
                    {delivery.last_error && <span className="min-w-0 flex-1 truncate text-danger" title={delivery.last_error}>{delivery.last_error}</span>}
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3">{relTime(delivery.updated_at)}</span>
                  </div>
                ))}
              </div>
              {failed && (
                <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-accent hover:bg-accent-soft">
                  <RotateCcw size={11} /> 重试失败投递
                </button>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function ActorChipShort(actor: string | null) {
  return <span className="font-mono" style={{ color: actorColor(actor) }}>{actor ?? "?"}</span>;
}

function compactJson(value: unknown) {
  return JSON.stringify(value).replace(/"/g, "").replace(/,"/g, ", ");
}

function BindingForm({ binding, onClose, onSaved }: { binding?: Binding; onClose: () => void; onSaved: () => void }) {
  const { tables, byName } = useApp();
  const editing = !!binding;
  const [name, setName] = useState(binding?.name ?? "");
  const [ops, setOps] = useState<Set<EventOp>>(new Set(binding?.ops ?? ["insert", "update", "delete"]));
  const [table, setTable] = useState(binding?.table_name ?? "");
  const [field, setField] = useState(binding?.field ?? "");
  const [where, setWhere] = useState(binding?.where ? JSON.stringify(binding.where, null, 2) : "");
  const [whereBefore, setWhereBefore] = useState(binding?.where_before ? JSON.stringify(binding.where_before, null, 2) : "");
  const [action, setAction] = useState<BindingAction>(binding?.action ?? "webhook");
  const [config, setConfig] = useState(binding ? JSON.stringify(binding.config, null, 2) : EXAMPLES.webhook);
  const [enabled, setEnabled] = useState(binding?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const fields = table ? byName[table]?.fields ?? [] : [];

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const changeAction = (next: BindingAction) => {
    if (!binding || binding.action !== next) setConfig(EXAMPLES[next]);
    setAction(next);
  };

  const submit = async () => {
    if (!name.trim()) return toast("error", "绑定需要一个名字");
    if (!ops.size) return toast("error", "至少选择一个操作");
    let parsedConfig: unknown;
    let parsedWhere: unknown = null;
    let parsedBefore: unknown = null;
    try {
      parsedConfig = JSON.parse(config || "{}");
    } catch {
      return toast("error", "动作配置不是合法 JSON");
    }
    try {
      parsedWhere = where.trim() ? JSON.parse(where) : null;
      parsedBefore = whereBefore.trim() ? JSON.parse(whereBefore) : null;
    } catch {
      return toast("error", "where 不是合法 JSON");
    }
    const body = {
      name: name.trim(),
      ops: [...ops],
      table: table || null,
      field: field || null,
      where: parsedWhere,
      where_before: parsedBefore,
      action,
      config: parsedConfig,
      enabled,
    };
    setBusy(true);
    try {
      if (editing) await api.updateBinding(binding.name, body);
      else await api.createBinding(body);
      toast("info", editing ? `已更新绑定 ${name}` : `已创建绑定 ${name}`);
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in fixed inset-0 z-30 flex items-center justify-center bg-[color-mix(in_oklab,var(--ink)_18%,transparent)] p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-[min(680px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-line px-5 py-3.5">
          <div>
            <div className="font-mono text-[11px] text-ink-3">{editing ? "编辑绑定" : "新建绑定"}</div>
            <h2 className="mt-0.5 font-display text-[26px] leading-tight">{editing ? binding.name : "绑定记录事件"}</h2>
          </div>
          <Btn onClick={onClose} className="ml-auto" title="关闭 (Esc)"><X size={16} /></Btn>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-5 py-4">
          <Row label="名称">
            <input
              autoFocus={!editing}
              value={name}
              disabled={editing}
              onChange={(e) => setName(e.target.value)}
              placeholder="notify-done"
              className={cx(input, "font-mono disabled:opacity-60")}
            />
          </Row>

          <Row label="操作">
            <div className="flex items-center gap-4 py-1.5">
              {(["insert", "update", "delete"] as EventOp[]).map((item) => (
                <label key={item} className="inline-flex items-center gap-1.5 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={ops.has(item)}
                    onChange={(e) => {
                      const next = new Set(ops);
                      e.target.checked ? next.add(item) : next.delete(item);
                      setOps(next);
                    }}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  {OP_LABEL[item]}
                </label>
              ))}
            </div>
          </Row>

          <div className="grid grid-cols-2 gap-3">
            <Row label="表">
              <select
                value={table}
                onChange={(e) => {
                  setTable(e.target.value);
                  setField("");
                }}
                className={input}
              >
                <option value="">整个域</option>
                {tables.map((t) => <option key={t.name} value={t.name}>{tableLabel(t, t.name)}（{t.name}）</option>)}
              </select>
            </Row>
            <Row label="字段">
              <select value={field} onChange={(e) => setField(e.target.value)} disabled={!table} className={cx(input, "disabled:opacity-40")}>
                <option value="">任意字段</option>
                {fields.map((f) => <option key={f.key} value={f.key}>{fieldLabel(f)}（{f.key}）</option>)}
              </select>
            </Row>
          </div>

          <Row label="动作">
            <select value={action} onChange={(e) => changeAction(e.target.value as BindingAction)} className={input}>
              {(["webhook", "command", "write", "inbox"] as BindingAction[]).map((item) => (
                <option key={item} value={item}>{ACTION_LABEL[item]}</option>
              ))}
            </select>
          </Row>

          <Row label="动作配置">
            <textarea
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              rows={6}
              spellCheck={false}
              className={cx(area, "resize-y font-mono text-[12px] leading-relaxed")}
            />
            <p className="mt-1 text-[11px] text-ink-3">
              webhook 需要 url；command 需要 cmd（事件 JSON 从 stdin 传入，每行一条）；write 需要 table 和 data；inbox 可写
              title / body 摘要，留空使用默认摘要。
              字符串里可用 <code className="font-mono">{"${event.record_id}"}</code>、<code className="font-mono">{"${record.title}"}</code>、<code className="font-mono">{"${fields.status.after}"}</code>。
              可选 <code className="font-mono">batch</code>（默认 20，一次动作合并几条投递）和 <code className="font-mono">max_pending</code>（默认 50000）。
            </p>
          </Row>

          <div className="grid grid-cols-2 gap-3">
            <Row label="where">
              <textarea
                value={where}
                onChange={(e) => setWhere(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={'{"status": "完成"}'}
                className={cx(area, "resize-y font-mono text-[12px]")}
              />
            </Row>
            <Row label="where_before">
              <textarea
                value={whereBefore}
                onChange={(e) => setWhereBefore(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder={'{"status": "待办"}'}
                className={cx(area, "resize-y font-mono text-[12px]")}
              />
            </Row>
          </div>

          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
            启用
          </label>
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="text-[11.5px] text-ink-3">绑定会执行 webhook 或本机命令，请确认动作可信</span>
          <Btn kind="ghost" className="ml-auto" onClick={onClose}>取消</Btn>
          <Btn kind="solid" disabled={busy} onClick={submit}>{busy ? "保存中…" : editing ? "保存" : "创建"}</Btn>
        </footer>
      </div>
    </div>
  );
}

const input = "h-8 w-full rounded-md border border-line-strong bg-surface px-2.5 outline-none focus:border-accent";
const area = "w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 outline-none focus:border-accent";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block font-mono text-[10.5px] tracking-wide text-ink-3 uppercase">{label}</span>
      {children}
    </div>
  );
}
