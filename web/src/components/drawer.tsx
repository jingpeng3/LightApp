import { History, Maximize2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Change, Field, FileStatuses, Rec, TableInfo } from "../api";
import { ACTOR, api, ApiError } from "../api";
import { useChanges } from "../live";
import { actorColor, brief, clock, cx, diffKeys, fieldLabel, recTitle, relTime, tableLabel, toast, toastError } from "../util";
import { CellView } from "./cells";
import { ChildTabs } from "./children";
import { editMode, InlineInput, PopoverEditor } from "./editors";
import { ActorChip, Btn, TypeGlyph, useApp, type Target } from "./ui";

function Shell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".fixed.z-50") && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fade-in fixed inset-0 z-30 flex bg-[color-mix(in_oklab,var(--ink)_18%,transparent)]" onMouseDown={onClose}>
      <div
        className="drawer ml-auto flex h-full w-[min(760px,100vw)] flex-col border-l border-line-strong bg-surface shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** 一条记录的详情：字段逐行编辑、子表 Tab、变更历史。 */
export function RecordDrawer({ target, onClose }: { target: Target; onClose: () => void }) {
  const { byName, openRecord, openFull } = useApp();
  const table = byName[target.table];
  const [rec, setRec] = useState<Rec | null>(null);
  const [gone, setGone] = useState(false);
  const [statuses, setStatuses] = useState<FileStatuses>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ keys: string[]; actor: string | null; n: number } | null>(null);
  const [tab, setTab] = useState<"fields" | "history">("fields");
  const rows = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(() => {
    setGone(false);
    api.get(target.table, target.id).then(setRec, (e) => (e instanceof ApiError && e.code === "not_found" ? setGone(true) : toastError(e)));
    api.fileStatus([target.id]).then(setStatuses, () => {});
  }, [target]);

  useEffect(() => {
    setRec(null);
    setEditing(null);
    setTab("fields");
    load();
  }, [load]);

  useChanges((c) => {
    if (c.table_name !== target.table || c.record_id !== target.id) return;
    if (c.op === "delete") return setGone(true);
    if (c.op === "update" && c.after) {
      setRec((r) => (r && r._version < c.after!._version ? c.after : r));
      if (c.actor !== ACTOR) setFlash({ keys: diffKeys(c.before, c.after), actor: c.actor, n: c.seq });
      api.fileStatus([target.id]).then(setStatuses, () => {});
    }
  });

  if (!table) return null;

  const save = async (f: Field, value: unknown) => {
    if (!rec) return false;
    setEditing(null);
    try {
      const next = await api.update(table.name, rec._id, { [f.key]: value }, rec._version);
      setRec(next);
      api.fileStatus([rec._id]).then(setStatuses, () => {});
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        load();
        toast("error", "这条记录刚被别人修改过，已刷新为最新内容", "确认后再改一次");
      } else toastError(e);
      return false;
    }
  };

  const remove = async () => {
    if (!rec) return;
    const counts = await Promise.all(table.children.map((c) => api.query(c, { parent_id: rec._id, limit: 1 }).then((r) => [c, r.total] as const)));
    const cascade = counts.filter(([, n]) => n > 0).map(([c, n]) => `${tableLabel(byName[c], c)} ${n} 条`);
    if (!confirm(`删除 ${tableLabel(table, table.name)} #${rec._id}「${recTitle(table, rec)}」？${cascade.length ? `\n\n会一起删除子记录：${cascade.join("、")}（以及它们的下级）` : ""}`)) return;
    api.remove(table.name, rec._id).then((r) => (toast("info", `已删除 ${r.deleted.length} 条记录`), onClose()), toastError);
  };

  const parent = table.parent ? byName[table.parent] : undefined;

  return (
    <Shell onClose={onClose}>
      <header className="border-b border-line px-6 pt-5 pb-0">
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
          {parent && rec?._parent_id != null && (
            <>
              <button type="button" onClick={() => openRecord({ table: parent.name, id: rec._parent_id! })} className="hover:text-accent">
                {tableLabel(parent, parent.name)} #{rec._parent_id}
              </button>
              <span>/</span>
            </>
          )}
          <span>{tableLabel(table, table.name)}</span>
          <span className="text-ink-2">#{target.id}</span>
          <span className="ml-auto flex items-center gap-1">
            <Btn onClick={() => openFull({ table: table.name, id: target.id })} disabled={!rec} title="全屏查看记录和子表"><Maximize2 size={14} /></Btn>
            <Btn kind="danger" onClick={remove} disabled={!rec} title="删除记录"><Trash2 size={13} /></Btn>
            <Btn onClick={onClose} title="关闭 (Esc)"><X size={15} /></Btn>
          </span>
        </div>
        <h2 className="mt-1 truncate font-display text-[34px] leading-[1.15]">{gone ? "记录已删除" : rec ? recTitle(table, rec) : "…"}</h2>
        {rec && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1">创建 <ActorChip actor={rec._created_by} small /> {relTime(rec._created_at)}</span>
            <span className="inline-flex items-center gap-1">更新 <ActorChip actor={rec._updated_by} small /> {relTime(rec._updated_at)}</span>
            <span className="font-mono">v{rec._version}</span>
          </div>
        )}
        <nav className="mt-3 flex gap-4">
          {(["fields", "history"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cx("relative pb-2 text-[12.5px]", tab === t ? "text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-accent" : "text-ink-3 hover:text-ink-2")}>
              {t === "fields" ? "字段" : "变更历史"}
            </button>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {gone ? (
          <div className="p-8 text-ink-3">这条记录已经被删除。</div>
        ) : !rec ? (
          <div className="p-8 text-ink-3">读取中…</div>
        ) : tab === "history" ? (
          <RecordHistory table={table} id={rec._id} />
        ) : (
          <>
            <div className="px-3 py-3">
              {table.fields.map((f) => {
                const mode = editMode(f);
                const isEditing = editing === f.key;
                const lit = flash?.keys.includes(f.key);
                return (
                  <div
                    key={f.key}
                    ref={(el) => void (rows.current[f.key] = el)}
                    className={cx("group relative flex min-h-[38px] items-start gap-3 rounded-md px-3", mode !== "none" && !isEditing && "cursor-pointer hover:bg-raise")}
                    style={lit ? { ["--actor" as string]: actorColor(flash!.actor) } : undefined}
                    onClick={() => {
                      if (mode === "toggle") void save(f, !rec[f.key]);
                      else if (mode !== "none") setEditing(f.key);
                    }}
                  >
                    {lit && <span key={flash!.n} className="flash pointer-events-none absolute inset-0 rounded-md" />}
                    <div className="flex w-[150px] shrink-0 items-center gap-1 pt-[10px] text-[12px] text-ink-3" title={`${f.key} · ${f.type}`}>
                      <TypeGlyph type={f.type} />
                      <span className="truncate">{fieldLabel(f)}</span>
                      {f.required && <span className="text-accent">*</span>}
                    </div>
                    <div className={cx("flex min-h-[38px] min-w-0 flex-1 items-center", f.type === "long_text" && !isEditing && "py-2")}>
                      {isEditing && mode === "inline" ? (
                        <div className="h-[30px] w-full overflow-hidden rounded-md ring-2 ring-accent" onClick={(e) => e.stopPropagation()}>
                          <InlineInput field={f} value={rec[f.key]} onCommit={(v) => save(f, v)} onCancel={() => setEditing(null)} />
                        </div>
                      ) : f.type === "long_text" && rec[f.key] ? (
                        <p className="whitespace-pre-wrap leading-relaxed">{String(rec[f.key])}</p>
                      ) : rec[f.key] == null && f.type !== "checkbox" ? (
                        <span className="text-ink-3 opacity-0 group-hover:opacity-100">{mode === "none" ? "—" : "点击填写"}</span>
                      ) : (
                        <span className="flex min-w-0 flex-wrap gap-1 [&>span]:flex-wrap">
                          <CellView field={f} value={rec[f.key]} rec={rec} states={statuses[rec._id]?.[f.key]} />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {table.children.length > 0 && (
              <section className="border-t border-line bg-panel px-6 py-4">
                <h3 className="mb-2 font-display text-[20px]">子表</h3>
                <ChildTabs table={table} parentId={rec._id} />
              </section>
            )}
          </>
        )}
      </div>
      {rec && editing && (() => {
        const f = table.fields.find((x) => x.key === editing);
        return f && editMode(f) === "popover" ? (
          <PopoverEditor field={f} rec={rec} anchor={rows.current[f.key]} onCommit={(v) => save(f, v)} onClose={() => setEditing(null)} />
        ) : null;
      })()}
    </Shell>
  );
}

function RecordHistory({ table, id }: { table: TableInfo; id: number }) {
  const [items, setItems] = useState<Change[] | null>(null);
  useEffect(() => {
    api.changes({ table: table.name, record_id: id, limit: 200 }).then((c) => setItems(c.reverse()), toastError);
  }, [table.name, id]);
  useChanges((c) => c.table_name === table.name && c.record_id === id && setItems((xs) => (xs ? [c, ...xs] : xs)));
  if (!items) return <div className="p-8 text-ink-3">读取中…</div>;
  return (
    <ol className="relative px-6 py-5">
      <span className="absolute top-6 bottom-6 left-[31px] w-px bg-line" />
      {items.map((c) => (
        <li key={c.seq} className="relative mb-4 flex gap-3 pl-7">
          <span className="absolute top-[5px] left-[3px] size-[9px] rounded-full ring-4 ring-surface" style={{ background: actorColor(c.actor) }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12px] text-ink-3">
              <ActorChip actor={c.actor} small />
              <span>{c.op === "insert" ? "创建了记录" : c.op === "delete" ? "删除了记录" : "修改了"}</span>
              <span className="ml-auto font-mono text-[11px]" title={c.ts}>{clock(c.ts)} · #{c.seq}</span>
            </div>
            {c.op === "update" && (
              <div className="mt-1 space-y-0.5">
                {diffKeys(c.before, c.after).map((k) => {
                  const f = table.fields.find((x) => x.key === k);
                  return (
                    <div key={k} className="flex flex-wrap items-baseline gap-1.5">
                      <span className="text-ink-2">{f ? fieldLabel(f) : k}</span>
                      <span className="text-ink-3 line-through decoration-ink-3/40">{brief(f, c.before?.[k])}</span>
                      <span className="text-ink-3">→</span>
                      <span>{brief(f, c.after?.[k])}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </li>
      ))}
      {!items.length && <li className="flex items-center gap-2 text-ink-3"><History size={14} /> 没有记录</li>}
    </ol>
  );
}

/** 新建记录表单。默认值预先填好，必填项没填时不能提交。 */
export function NewRecordDrawer({ tableName, parentId, onClose }: { tableName: string; parentId?: number | null; onClose: () => void }) {
  const { byName, openRecord } = useApp();
  const table = byName[tableName];
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(table?.fields.filter((f) => f.default != null).map((f) => [f.key, f.default]) ?? []),
  );
  const [busy, setBusy] = useState(false);
  if (!table) return null;
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const missing = table.fields.filter((f) => f.required && (draft[f.key] == null || draft[f.key] === "" || (Array.isArray(draft[f.key]) && !(draft[f.key] as unknown[]).length)));
  const needParent = table.parent !== null && parentId == null;
  const parentInput = (draft._parent as string | undefined) ?? "";
  const setParentInput = (v: string) => set("_parent", v);
  const parentMissing = needParent && !/^\d+$/.test(parentInput);

  const submit = async () => {
    const data: Record<string, unknown> = {};
    for (const f of table.fields) {
      let v = draft[f.key];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      if (f.type === "attachment") {
        const paths = String(v).split("\n").map((s) => s.trim()).filter(Boolean);
        v = f.config?.multiple ? paths : paths[0];
      } else if (f.type === "link") {
        const ids = String(v).split(/[\s,，]+/).filter(Boolean).map(Number);
        v = f.config?.multiple ? ids : ids[0];
      } else if (f.type === "datetime") v = new Date(String(v)).toISOString();
      data[f.key] = v;
    }
    setBusy(true);
    try {
      const rec = await api.insert(table.name, data, needParent ? Number(parentInput) : parentId);
      toast("info", `已新建 ${tableLabel(table, table.name)} #${rec._id}`);
      openRecord({ table: table.name, id: rec._id });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const input = "h-8 w-full rounded-md bg-raise px-2.5 outline-none focus:ring-2 focus:ring-accent";

  return (
    <Shell onClose={onClose}>
      <header className="border-b border-line px-6 py-5">
        <div className="flex items-center font-mono text-[11px] text-ink-3">
          <span>{tableLabel(table, table.name)}{parentId != null && ` · 属于 ${table.parent} #${parentId}`}</span>
          <Btn onClick={onClose} className="ml-auto" title="关闭 (Esc)"><X size={15} /></Btn>
        </div>
        <h2 className="font-display text-[34px] leading-tight">新建<span className="italic text-accent">记录</span></h2>
      </header>
      <form className="min-h-0 flex-1 space-y-1 overflow-auto px-6 py-4" onSubmit={(e) => (e.preventDefault(), submit())}>
        {needParent && (
          <Row label={`${tableLabel(byName[table.parent!], table.parent!)} _id`} required>
            <input autoFocus className={cx(input, "font-mono")} inputMode="numeric" value={parentInput} onChange={(e) => setParentInput(e.target.value)} placeholder="父记录的 _id" />
          </Row>
        )}
        {table.fields.map((f) => (
          <Row key={f.key} field={f} label={fieldLabel(f)} required={f.required}>
            {f.type === "auto_number" ? (
              <span className="font-mono text-ink-3">自动分配</span>
            ) : f.type === "checkbox" ? (
              <input type="checkbox" checked={!!draft[f.key]} onChange={(e) => set(f.key, e.target.checked)} className="size-4 accent-[var(--accent)]" />
            ) : f.type === "single_select" || f.type === "multi_select" ? (
              <div className="flex flex-wrap gap-1.5 py-1">
                {f.options?.map((o) => {
                  const cur = draft[f.key];
                  const on = f.type === "single_select" ? cur === o.value : Array.isArray(cur) && cur.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => {
                        if (f.type === "single_select") set(f.key, on ? null : o.value);
                        else {
                          const list = Array.isArray(cur) ? (cur as string[]) : [];
                          set(f.key, on ? list.filter((x) => x !== o.value) : [...list, o.value]);
                        }
                      }}
                      className={cx("rounded-[5px] p-[2px] transition-shadow", on ? "shadow-[0_0_0_1.5px_var(--accent)]" : "opacity-55 hover:opacity-100")}
                    >
                      <span className="inline-flex h-[20px] items-center rounded-[4px] px-1.5 text-[12px]" style={{ background: `var(--opt-${o.color}-bg)`, color: `var(--opt-${o.color}-fg)` }}>{o.value}</span>
                    </button>
                  );
                })}
              </div>
            ) : f.type === "long_text" || f.type === "attachment" ? (
              <textarea
                rows={f.type === "attachment" ? 2 : 4}
                value={String(draft[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.type === "attachment" ? `绝对路径${f.config?.multiple ? "，每行一个" : ""}` : undefined}
                className={cx("w-full resize-y rounded-md bg-raise px-2.5 py-1.5 leading-relaxed outline-none focus:ring-2 focus:ring-accent", f.type === "attachment" && "font-mono text-[12px]")}
              />
            ) : (
              <input
                className={cx(input, ["number", "date", "datetime", "link"].includes(f.type) && "font-mono")}
                type={({ date: "date", datetime: "datetime-local", url: "url", email: "email" } as Record<string, string>)[f.type] ?? "text"}
                inputMode={f.type === "number" ? "decimal" : undefined}
                value={String(draft[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.type === "link" ? `${f.config?.table} 的 _id${f.config?.multiple ? "，逗号分隔" : ""}` : undefined}
              />
            )}
          </Row>
        ))}
        <button type="submit" hidden />
      </form>
      <footer className="flex items-center gap-3 border-t border-line px-6 py-3">
        {(missing.length > 0 || parentMissing) && (
          <span className="text-[12px] text-ink-3">
            还需填写：{[...(parentMissing ? ["父记录"] : []), ...missing.map(fieldLabel)].join("、")}
          </span>
        )}
        <Btn kind="ghost" className="ml-auto" onClick={onClose}>取消</Btn>
        <Btn kind="solid" disabled={busy || missing.length > 0 || parentMissing} onClick={submit}>创建</Btn>
      </footer>
    </Shell>
  );
}

function Row({ label, required, field, children }: { label: string; required?: boolean; field?: Field; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-3 py-1">
      <span className="flex w-[150px] shrink-0 items-center gap-1 pt-[7px] text-[12px] text-ink-3" title={field ? `${field.key} · ${field.type}` : undefined}>
        {field ? <TypeGlyph type={field.type} /> : <span className="w-[18px] text-center font-mono text-[11px]">↖</span>}
        <span className="truncate">{label}</span>
        {required && <span className="text-accent">*</span>}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}
