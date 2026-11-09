import { Check, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Attachment, Field, Rec } from "../api";
import { api } from "../api";
import { asList, cx, recTitle, toastError } from "../util";
import { Popover, Tag, useApp } from "./ui";

/** 编辑方式：inline 在单元格原位放输入框，popover 弹出浮层，toggle 直接切换。 */
export function editMode(f: Field): "inline" | "popover" | "toggle" | "none" {
  if (f.type === "auto_number") return "none";
  if (f.type === "checkbox") return "toggle";
  if (["long_text", "single_select", "multi_select", "link", "attachment"].includes(f.type)) return "popover";
  return "inline";
}

const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(v: unknown) {
  if (!v) return "";
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const INPUT_TYPE: Partial<Record<Field["type"], string>> = { date: "date", datetime: "datetime-local", number: "text", url: "url", email: "email" };

export function InlineInput({ field: f, value, onCommit, onCancel, initial }: {
  field: Field;
  value: unknown;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  initial?: string;
}) {
  const start = f.type === "datetime" ? toLocalInput(value) : value == null ? "" : String(value);
  const [text, setText] = useState(initial ?? start);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (text === start) return onCancel();
    if (!text.trim()) return onCommit(null);
    onCommit(f.type === "datetime" ? new Date(text).toISOString() : text);
  };
  return (
    <input
      autoFocus
      type={INPUT_TYPE[f.type] ?? "text"}
      inputMode={f.type === "number" ? "decimal" : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
        if (e.key === "Escape") (done.current = true), onCancel();
      }}
      className={cx("h-full w-full bg-surface px-2.5 outline-none", f.type === "number" && "text-right font-mono", (f.type === "date" || f.type === "datetime") && "font-mono")}
    />
  );
}

/** 弹出式编辑器：长文本、单选、多选、关联、附件。 */
export function PopoverEditor({ field: f, rec, anchor, onCommit, onClose }: {
  field: Field;
  rec: Rec;
  anchor: HTMLElement | null;
  onCommit: (v: unknown) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const value = rec[f.key];
  const width = f.type === "long_text" ? 380 : f.type === "attachment" ? 420 : 260;
  return (
    <Popover anchor={anchor} onClose={onClose} width={width}>
      {f.type === "long_text" && <LongText value={value} onCommit={(v) => (onCommit(v), onClose())} onCancel={onClose} />}
      {f.type === "single_select" && <Options field={f} selected={asList<string>(value)} onPick={(v) => (onCommit(v === value ? null : v), onClose())} />}
      {f.type === "multi_select" && (
        <Options
          field={f}
          multi
          selected={asList<string>(value)}
          onPick={(v) => {
            const cur = asList<string>(value);
            onCommit(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
          }}
        />
      )}
      {f.type === "link" && <LinkPicker field={f} value={value} onCommit={onCommit} onClose={onClose} />}
      {f.type === "attachment" && <AttachmentEditor field={f} value={value} onCommit={onCommit} />}
    </Popover>
  );
}

function LongText({ value, onCommit, onCancel }: { value: unknown; onCommit: (v: unknown) => void; onCancel: () => void }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => (text === (value ?? "") ? onCancel() : onCommit(text.trim() ? text : null));
  return (
    <div className="p-2">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
        rows={8}
        className="w-full resize-y rounded-md bg-raise p-2.5 leading-relaxed outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-ink-3">
        <span className="font-mono">⌘↵ 保存 · Esc 取消</span>
        <button type="button" onClick={save} className="rounded-md bg-ink px-2.5 py-1 text-surface hover:bg-accent">保存</button>
      </div>
    </div>
  );
}

function Options({ field: f, selected, multi, onPick }: { field: Field; selected: string[]; multi?: boolean; onPick: (v: string) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const opts = (f.options ?? []).filter((o) => o.value.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="p-1">
      {(f.options?.length ?? 0) > 6 && (
        <input
          autoFocus
          value={q}
          onChange={(e) => (setQ(e.target.value), setActive(0))}
          placeholder="筛选选项"
          className="mb-1 h-7 w-full rounded-md bg-raise px-2 outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, opts.length - 1));
            if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            if (e.key === "Enter" && opts[active]) onPick(opts[active].value);
          }}
        />
      )}
      {opts.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(o.value)}
          className={cx("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left", i === active && "bg-raise")}
        >
          <span className={cx("flex size-[14px] items-center justify-center", !multi && "rounded-full")}>
            {selected.includes(o.value) && <Check size={13} className="text-accent" strokeWidth={2.5} />}
          </span>
          <Tag value={o.value} color={o.color} />
        </button>
      ))}
      {!opts.length && <div className="px-2 py-3 text-ink-3">没有匹配的选项</div>}
      {multi && <div className="px-2 pt-1 pb-0.5 text-[11px] text-ink-3">点击切换，可多选</div>}
    </div>
  );
}

function LinkPicker({ field: f, value, onCommit, onClose }: {
  field: Field;
  value: unknown;
  onCommit: (v: unknown) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const { byName } = useApp();
  const target = f.config!.table!;
  const table = byName[target];
  const multiple = !!f.config?.multiple;
  const selected = asList<number>(value);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Rec[]>([]);

  useEffect(() => {
    const textFields = table?.fields.filter((x) => x.type === "text" || x.type === "long_text") ?? [];
    const where = !q.trim()
      ? null
      : /^\d+$/.test(q.trim())
        ? { _id: Number(q.trim()) }
        : textFields.length ? { $or: textFields.map((x) => ({ [x.key]: { contains: q.trim() } })) } : null;
    const timer = setTimeout(() => {
      api.query(target, { where, sort: "-_updated_at", limit: 30 }).then((r) => setRows(r.items), toastError);
    }, 150);
    return () => clearTimeout(timer);
  }, [q, target, table]);

  const pick = (id: number) => {
    if (multiple) onCommit(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else (onCommit(selected[0] === id ? null : id), onClose());
  };

  return (
    <div className="p-1">
      <div className="mb-1 flex h-8 items-center gap-1.5 rounded-md bg-raise px-2">
        <Search size={13} className="text-ink-3" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`搜索 ${table?.label || target}，或输入 _id`} className="w-full bg-transparent outline-none" />
      </div>
      <div className="max-h-64 overflow-auto">
        {rows.map((r) => (
          <button key={r._id} type="button" onClick={() => pick(r._id)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-raise">
            <span className="flex size-[14px] items-center justify-center">{selected.includes(r._id) && <Check size={13} className="text-accent" strokeWidth={2.5} />}</span>
            <span className="w-10 shrink-0 font-mono text-[11px] text-ink-3">#{r._id}</span>
            <span className="truncate">{recTitle(table, r)}</span>
          </button>
        ))}
        {!rows.length && <div className="px-2 py-3 text-ink-3">没有记录</div>}
      </div>
    </div>
  );
}

function AttachmentEditor({ field: f, value, onCommit }: { field: Field; value: unknown; onCommit: (v: unknown) => void | Promise<unknown> }) {
  const items = asList<Attachment>(value);
  const multiple = !!f.config?.multiple;
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (next: (Attachment | string)[]) => {
    setBusy(true);
    const ok = await onCommit(multiple ? next : next[0] ?? null);
    setBusy(false);
    if (ok !== false) setPath("");
  };
  const add = () => {
    const p = path.trim();
    if (p) void save(multiple ? [...items, p] : [p]);
  };
  return (
    <div className="p-2">
      {items.map((a, i) => (
        <div key={a.path} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-raise">
          <span className="w-8 shrink-0 font-mono text-[10.5px] text-ink-3 uppercase">{a.kind === "dir" ? "dir" : a.name.split(".").pop()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{a.name}</span>
            <span className="block truncate font-mono text-[10.5px] text-ink-3">{a.path}</span>
          </span>
          <button type="button" title="移除" disabled={busy} onClick={() => save(items.filter((_, j) => j !== i))} className="text-ink-3 opacity-0 group-hover:opacity-100 hover:text-danger">
            <X size={14} />
          </button>
        </div>
      ))}
      <div className={cx("flex items-center gap-1.5", items.length > 0 && "mt-1.5 border-t border-line pt-2")}>
        <input
          autoFocus
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
          placeholder={multiple || !items.length ? "粘贴文件或目录的绝对路径" : "粘贴新路径以替换"}
          className="h-8 min-w-0 flex-1 rounded-md bg-raise px-2 font-mono text-[12px] outline-none"
        />
        <button type="button" disabled={busy || !path.trim()} onClick={add} className="flex h-8 items-center gap-1 rounded-md bg-ink px-2.5 text-surface hover:bg-accent disabled:opacity-40">
          <Plus size={13} />
          {multiple || !items.length ? "添加" : "替换"}
        </button>
      </div>
      {f.config?.accept && <div className="mt-1.5 font-mono text-[10.5px] text-ink-3">接受 {f.config.accept.join(" ")}（目录不限）</div>}
    </div>
  );
}
