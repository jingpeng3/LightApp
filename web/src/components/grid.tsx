import {
  flexRender, getCoreRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Maximize2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Field, Rec, TableInfo } from "../api";
import { useRecords } from "../useRecords";
import { actorColor, actorName, cx, fieldLabel, relTime } from "../util";
import { CellView } from "./cells";
import { ChildTabs } from "./children";
import { editMode, InlineInput, PopoverEditor } from "./editors";
import { ActorChip, Empty, TypeGlyph, useApp } from "./ui";

const WIDTH: Record<Field["type"], number> = {
  text: 220, long_text: 260, number: 110, date: 120, datetime: 170, checkbox: 76, single_select: 140, multi_select: 200,
  url: 200, email: 190, person: 140, auto_number: 84, link: 170, attachment: 240,
};
const ROW_H = 36;
const GUTTER = "_gutter";
const PARENT = "_parent_id";
const UPDATED = "_updated_at";

type Col = ColumnDef<Rec> & { meta: { field?: Field } };

const PAGE_SIZES = [50, 100, 200, 500];
const CHILD_PAGE_SIZE = 20;
const savedPageSize = () => {
  const n = Number(localStorage.getItem("dt-page-size"));
  return PAGE_SIZES.includes(n) ? n : 100;
};

export function Grid({ table, parentId, search = "", compact }: {
  table: TableInfo;
  parentId?: number | null;
  search?: string;
  compact?: boolean;
}) {
  const { domain, byName, openRecord, openFull, openNew } = useApp();
  const [sorting, setSorting] = useState<SortingState>([]);
  // 搜索框每敲一个字都会变，停顿 250ms 再查服务端
  const [query, setQuery] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(compact ? CHILD_PAGE_SIZE : savedPageSize);
  const sort = sorting.length ? sorting.map((s) => (s.desc ? "-" : "") + s.id).join(",") : null;
  const { rows, total, loading, stale, flashes, entering, leaving, statuses, update, reload } = useRecords(table, parentId, { page, pageSize, sort, search: query });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const [active, setActive] = useState<{ id: number; key: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; key: string; initial?: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const showParent = table.parent !== null && parentId == null;
  const parentTable = table.parent ? byName[table.parent] : undefined;
  const hasChildren = table.children.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows === null]); // 加载完成前渲染的是骨架屏，scrollRef 还没挂上

  useEffect(() => {
    setActive(null);
    setEditing(null);
    setExpanded(new Set());
  }, [table.name, parentId, page]);

  // 换了搜索词或排序就回到第一页；删除导致当前页超出范围时退回最后一页
  useEffect(() => setPage(0), [query, sort]);
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);

  const goto = (p: number) => {
    setPage(Math.min(Math.max(p, 0), pages - 1));
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const columns = useMemo<Col[]>(() => {
    const cols: Col[] = [{ id: GUTTER, size: hasChildren ? 96 : 78, enableResizing: false, enableSorting: false, meta: {} }];
    if (showParent) cols.push({ id: PARENT, accessorKey: PARENT, header: parentTable?.label || table.parent!, size: 130, meta: {} });
    for (const f of table.fields) {
      cols.push({ id: f.key, accessorFn: (r) => r[f.key], header: fieldLabel(f), size: WIDTH[f.type], minSize: 60, meta: { field: f } });
    }
    cols.push({ id: UPDATED, accessorKey: UPDATED, header: "最后更新", size: 150, meta: {} });
    return cols;
  }, [table, hasChildren, showParent, parentTable]);

  const rt = useReactTable({
    data: rows ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true, // 排序在服务端，对全部记录生效，不只是当前页
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => String(r._id),
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 50, maxSize: 800 },
  });
  const sorted = rt.getRowModel().rows;
  const fieldCols = rt.getVisibleLeafColumns().filter((c) => (c.columnDef as Col).meta.field);
  const totalW = rt.getTotalSize();
  const rowW = Math.max(totalW, viewW); // 列不够宽时，表头和行背景铺满可视区域

  const virt = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => sorted[i].id,
  });

  const cellEl = (id: number, key: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${id}:${key}"]`) ?? null;
  const fieldOf = (key: string) => table.fields.find((f) => f.key === key);
  const recOf = (id: number) => rows?.find((r) => r._id === id);

  const commit = async (rec: Rec, key: string, value: unknown) => {
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
    return update(rec, { [key]: value });
  };

  const startEdit = (rec: Rec, f: Field, initial?: string) => {
    const mode = editMode(f);
    if (mode === "none") return;
    if (mode === "toggle") return void update(rec, { [f.key]: !rec[f.key] });
    setEditing({ id: rec._id, key: f.key, initial: mode === "inline" ? initial : undefined });
  };

  const move = (dRow: number, dCol: number) => {
    if (!sorted.length || !fieldCols.length) return;
    const ri = active ? sorted.findIndex((r) => r.original._id === active.id) : -1;
    const ci = active ? fieldCols.findIndex((c) => c.id === active.key) : -1;
    const nr = Math.min(Math.max(ri + dRow, 0), sorted.length - 1);
    const nc = Math.min(Math.max((ci < 0 ? 0 : ci) + dCol, 0), fieldCols.length - 1);
    setActive({ id: sorted[nr].original._id, key: fieldCols[nc].id });
    virt.scrollToIndex(nr);
    requestAnimationFrame(() => cellEl(sorted[nr].original._id, fieldCols[nc].id)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (editing || e.target !== scrollRef.current) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) return e.preventDefault(), move(...arrows[e.key]);
    if (e.key === "Tab") return e.preventDefault(), move(0, e.shiftKey ? -1 : 1);
    if (!active) return;
    const rec = recOf(active.id);
    const f = fieldOf(active.key);
    if (!rec || !f) return;
    if (e.key === "Enter") return e.preventDefault(), startEdit(rec, f);
    if (e.key === "Escape") return setActive(null);
    if (e.key === " " && f.type === "checkbox") return e.preventDefault(), startEdit(rec, f);
    if ((e.key === "Backspace" || e.key === "Delete") && editMode(f) !== "none" && rec[f.key] != null && !f.required) {
      return e.preventDefault(), void update(rec, { [f.key]: f.type === "checkbox" ? false : null });
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && editMode(f) === "inline") return e.preventDefault(), startEdit(rec, f, e.key);
  };

  if (rows === null) {
    return (
      <div className={cx("space-y-px p-4", compact && "p-2")}>
        {Array.from({ length: compact ? 3 : 8 }, (_, i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-raise" style={{ opacity: 1 - i * 0.1, animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    );
  }

  const editRec = editing ? recOf(editing.id) : undefined;
  const editField = editing ? fieldOf(editing.key) : undefined;
  const canAdd = !(table.relation === "one_to_one" && parentId != null && total > 0);

  return (
    <div className={cx("relative flex min-h-0 flex-col", !compact && "flex-1")}>
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={onKey}
        className={cx("relative min-h-0 overflow-auto outline-none", compact ? "max-h-[320px]" : "flex-1")}
      >
        <div style={{ width: totalW, minWidth: "100%" }}>
          {/* 表头 */}
          <div className="sticky top-0 z-20 flex border-b border-line-strong bg-panel" style={{ width: rowW }}>
            {rt.getFlatHeaders().map((h) => {
              const f = (h.column.columnDef as Col).meta.field;
              const sortDir = h.column.getIsSorted();
              const isGutter = h.id === GUTTER;
              return (
                <div
                  key={h.id}
                  style={{ width: h.getSize() }}
                  className={cx(
                    "group relative flex h-8 shrink-0 items-center gap-1 border-r border-line px-2 text-[11.5px] font-medium tracking-wide text-ink-2 select-none",
                    isGutter && "sticky left-0 z-10 bg-panel",
                    h.column.getCanSort() && "cursor-pointer hover:text-ink",
                  )}
                  onClick={h.column.getCanSort() ? h.column.getToggleSortingHandler() : undefined}
                  title={f ? `${f.key} · ${f.type}${f.description ? `\n${f.description}` : ""}` : undefined}
                >
                  {isGutter ? <span className="pl-1 font-mono text-[10.5px] text-ink-3">_id</span> : (
                    <>
                      {f ? <TypeGlyph type={f.type} /> : <span className="w-[18px] text-center font-mono text-[11px] text-ink-3">{h.id === PARENT ? "↖" : "◷"}</span>}
                      <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                      {f?.required && <span className="text-accent">*</span>}
                      {sortDir === "asc" && <ArrowUp size={11} className="text-accent" />}
                      {sortDir === "desc" && <ArrowDown size={11} className="text-accent" />}
                    </>
                  )}
                  {h.column.getCanResize() && (
                    <div
                      onMouseDown={h.getResizeHandler()}
                      onClick={(e) => e.stopPropagation()}
                      className={cx("absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize", h.column.getIsResizing() ? "bg-accent" : "hover:bg-line-strong")}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* 表体 */}
          <div className="relative" style={{ height: virt.getTotalSize() }}>
            {virt.getVirtualItems().map((vi) => {
              const row = sorted[vi.index];
              const rec = row.original;
              const isOpen = expanded.has(rec._id);
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  className={cx("absolute left-0", entering.has(rec._id) && "row-in", leaving.has(rec._id) && "row-out")}
                  style={{ transform: `translateY(${vi.start}px)`, width: rowW, ["--actor" as string]: actorColor(rec._updated_by) }}
                >
                  <div className="group/row flex border-b border-line bg-surface hover:bg-[color-mix(in_oklab,var(--raise)_60%,var(--surface))]">
                    {row.getVisibleCells().map((cell) => {
                      const id = cell.column.id;
                      const w = cell.column.getSize();
                      if (id === GUTTER) {
                        return (
                          <div key={id} style={{ width: w }} className="sticky left-0 z-10 flex h-9 shrink-0 items-center gap-0.5 border-r border-line bg-inherit pl-1 shadow-[inset_-2px_0_0_var(--accent-soft)]">
                            {hasChildren && (
                              <button
                                type="button"
                                title={isOpen ? "收起子表" : "展开子表"}
                                onClick={() => setExpanded((s) => { const n = new Set(s); n.has(rec._id) ? n.delete(rec._id) : n.add(rec._id); return n; })}
                                className="flex size-5 items-center justify-center rounded text-ink-3 hover:bg-raise hover:text-ink"
                              >
                                <ChevronRight size={13} className={cx("transition-transform", isOpen && "rotate-90")} />
                              </button>
                            )}
                            <button
                              type="button"
                              title="打开记录"
                              onClick={() => openRecord({ table: table.name, id: rec._id })}
                              className="h-5 rounded px-1 font-mono text-[11px] text-ink-3 hover:bg-accent-soft hover:text-accent"
                            >
                              {rec._id}
                            </button>
                            <button
                              type="button"
                              title="全屏查看记录和子表"
                              onClick={() => openFull({ table: table.name, id: rec._id })}
                              className="flex size-5 items-center justify-center rounded text-ink-3 opacity-0 hover:bg-raise hover:text-ink group-hover/row:opacity-100 focus-visible:opacity-100"
                            >
                              <Maximize2 size={12} />
                            </button>
                          </div>
                        );
                      }
                      if (id === PARENT) {
                        return (
                          <div key={id} style={{ width: w }} className="flex h-9 shrink-0 items-center border-r border-line px-2">
                            {rec._parent_id != null && (
                              <button type="button" onClick={() => openRecord({ table: table.parent!, id: rec._parent_id! })} className="h-[20px] rounded-[4px] border border-line-strong px-1.5 font-mono text-[11.5px] text-ink-2 hover:border-accent hover:text-accent">
                                {table.parent}#{rec._parent_id}
                              </button>
                            )}
                          </div>
                        );
                      }
                      if (id === UPDATED) {
                        return (
                          <div key={id} style={{ width: w }} className="flex h-9 shrink-0 items-center gap-2 border-r border-line px-2 text-[11.5px] text-ink-3" title={rec._updated_at}>
                            <ActorChip actor={rec._updated_by} small />
                            <span className="truncate">{relTime(rec._updated_at)}</span>
                          </div>
                        );
                      }
                      const f = (cell.column.columnDef as Col).meta.field!;
                      const isActive = active?.id === rec._id && active.key === id;
                      const isEditing = editing?.id === rec._id && editing.key === id;
                      const fl = flashes[`${rec._id}:${id}`];
                      return (
                        <div
                          key={id}
                          data-cell={`${rec._id}:${id}`}
                          style={{ width: w, ...(fl ? { ["--actor" as string]: actorColor(fl.actor) } : {}) }}
                          onMouseDown={() => setActive({ id: rec._id, key: id })}
                          onDoubleClick={() => startEdit(rec, f)}
                          onClick={() => isActive && editMode(f) === "toggle" && startEdit(rec, f)}
                          className={cx(
                            "relative flex h-9 shrink-0 items-center overflow-hidden border-r border-line",
                            !(isEditing && editMode(f) === "inline") && "px-2.5",
                            f.type === "checkbox" && "justify-center",
                            isActive && "z-[1] ring-2 ring-accent ring-inset",
                          )}
                        >
                          {fl && <span key={fl.n} className="flash pointer-events-none absolute inset-0" />}
                          {isEditing && editMode(f) === "inline" ? (
                            <InlineInput field={f} value={rec[id]} initial={editing.initial} onCommit={(v) => commit(rec, id, v)} onCancel={() => (setEditing(null), scrollRef.current?.focus())} />
                          ) : (
                            <span className="relative flex min-w-0 flex-1 items-center">
                              <CellView field={f} value={rec[id]} rec={rec} states={statuses[rec._id]?.[id]} />
                            </span>
                          )}
                          {fl && (
                            <span key={`t${fl.n}`} className="actor-tag pointer-events-none absolute top-0 right-0 rounded-bl-[4px] px-1 font-mono text-[9.5px] leading-[14px] text-white" style={{ background: actorColor(fl.actor) }}>
                              {actorName(fl.actor)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {isOpen && (
                    <div className="sticky left-0 border-b border-line bg-panel py-2 pr-3 pl-10" style={{ width: viewW }}>
                      <ChildTabs table={table} parentId={rec._id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!sorted.length && (
            <div className="sticky left-0" style={{ width: viewW }}>
              {search ? <Empty title="没有匹配的记录" /> : compact ? <div className="px-4 py-4 text-ink-3">还没有记录</div> : (
                <Empty title="空白的一页">
                  这张表还没有记录。让 agent 运行 <code className="font-mono text-ink-2">dt rec insert {table.name} -D {domain} --data '…'</code>，或者点下面的「新建记录」。
                </Empty>
              )}
            </div>
          )}

          {canAdd && (
            <div className="sticky left-0" style={{ width: viewW }}>
              <button
                type="button"
                onClick={() => openNew(table.name, parentId)}
                className="flex h-9 w-full items-center gap-1.5 border-b border-dashed border-line pl-3 text-ink-3 hover:bg-surface hover:text-accent"
              >
                <Plus size={13} /> 新建{compact ? "" : "记录"}
              </button>
            </div>
          )}
        </div>
      </div>
      {(!compact || total > pageSize || stale > 0) && (
        <div className={cx("flex shrink-0 items-center gap-3 border-t border-line bg-panel px-3 font-mono text-[11px] text-ink-3", compact ? "h-8" : "h-9")}>
          <span>
            {query.trim() ? `匹配 ${total} 条` : `${total} 条`}
            {total > 0 && ` · ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)}`}
          </span>
          {loading && <span className="text-ink-3">读取中…</span>}
          {stale > 0 && (
            <button type="button" onClick={reload} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-accent hover:bg-accent-soft">
              <RefreshCw size={11} /> {stale} 条新变更，刷新
            </button>
          )}
          {!compact && <span className="hidden xl:inline">↑↓←→ 移动 · Enter 编辑 · 直接输入覆盖 · ⌫ 清空</span>}
          <span className="ml-auto flex items-center gap-2">
            {!compact && (
              <select
                value={pageSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  localStorage.setItem("dt-page-size", String(n));
                  setPageSize(n);
                  setPage(0);
                }}
                className="h-6 rounded border border-line-strong bg-surface px-1 outline-none"
                title="每页条数"
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} 条/页</option>)}
              </select>
            )}
            {pages > 1 && <Pager page={page} pages={pages} onGo={goto} />}
          </span>
        </div>
      )}
      {editing && editRec && editField && editMode(editField) === "popover" && (
        <PopoverEditor
          field={editField}
          rec={editRec}
          anchor={cellEl(editRec._id, editField.key)}
          onCommit={(v) => update(editRec, { [editField.key]: v })}
          onClose={() => (setEditing(null), scrollRef.current?.focus({ preventScroll: true }))}
        />
      )}
    </div>
  );
}

/** 页码：首尾页、当前页前后各一页，中间用省略号。 */
function Pager({ page, pages, onGo }: { page: number; pages: number; onGo: (p: number) => void }) {
  const shown = [...new Set([0, page - 1, page, page + 1, pages - 1])].filter((p) => p >= 0 && p < pages).sort((a, b) => a - b);
  const btn = "inline-flex h-6 min-w-6 items-center justify-center rounded px-1.5 hover:bg-raise hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <span className="flex items-center gap-0.5">
      <button type="button" className={btn} disabled={page === 0} onClick={() => onGo(page - 1)} title="上一页"><ChevronLeft size={13} /></button>
      {shown.map((p, i) => (
        <span key={p} className="flex items-center gap-0.5">
          {i > 0 && p - shown[i - 1] > 1 && <span className="px-0.5">…</span>}
          <button type="button" className={cx(btn, p === page && "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]")} onClick={() => onGo(p)}>{p + 1}</button>
        </span>
      ))}
      <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onGo(page + 1)} title="下一页"><ChevronRight size={13} /></button>
    </span>
  );
}
