import { ChevronDown, Crosshair, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { Filters, SimNode } from "../graphModel";
import { actorColor, actorName, cx, tableLabel } from "../util";
import { Btn, Popover, useApp } from "./ui";

/** 节点上的操作动画：谁、做了什么、改了哪些字段（已换成字段名）。 */
export interface Pulse {
  t: number;
  actor: string | null;
  op: string;
  fields: string[];
}

export interface ActivityItem extends Pulse {
  seq: number;
  table: string;
  id: number;
  title: string;
}

const VERB: Record<string, string> = { insert: "新建", update: "修改", delete: "删除" };
const chip = (on: boolean) => cx(
  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors",
  on ? "border-line-strong text-ink" : "border-dashed border-line-strong text-ink-3 hover:text-ink-2",
);

export function GraphBar({ f, setF, stats, actors, linkFields, colorOf, focusTitle, search, onReheat }: {
  f: Filters;
  setF: (patch: Partial<Filters>) => void;
  stats: ReactNode;
  actors: { name: string; count: number }[];
  linkFields: { key: string; label: string }[];
  colorOf: Map<string, string>;
  focusTitle: string | null;
  search: (q: string) => SimNode[];
  onReheat: () => void;
}) {
  const { tables } = useApp();
  const all = tables.map((t) => t.name);
  const toggleTable = (name: string) => {
    const cur = f.tables ?? all;
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    if (next.length) setF({ tables: next.length === all.length ? null : next, focus: null });
  };
  const edges = [{ key: "parent", label: "父子" }, ...linkFields, { key: "actor", label: "操作者 → 记录" }];
  const offCount = edges.filter((e) => f.off.includes(e.key)).length;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <header className="rise px-6 pt-5 pb-3">
      <div className="flex items-end gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] text-ink-3">@graph</div>
          <h1 className="font-display text-[40px] leading-[1.05]">知识图谱</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">{stats}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Seg value={f.view} options={[["records", "记录图"], ["tables", "表概览"]]} onChange={(view) => setF({ view })} />
          {f.view === "records" && <SearchBox search={search} onPick={(n) => setF({ focus: n.rid! })} />}
          <Btn kind="line" onClick={onReheat} title="重新布局" className="h-8"><RefreshCw size={14} /></Btn>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {f.view === "records" && (
          <button type="button" onClick={() => setF({ tables: null, focus: null })} className={chip(f.tables === null)}>全部表</button>
        )}
        {tables.map((t) => (
          <button
            key={t.name}
            type="button"
            title={f.view === "tables" ? "只看这张表的记录" : "显示 / 隐藏这张表"}
            onClick={() => (f.view === "tables" ? setF({ view: "records", tables: [t.name], focus: null }) : toggleTable(t.name))}
            className={chip(f.view === "tables" || !f.tables || f.tables.includes(t.name))}
          >
            <span className={cx("shrink-0 rounded-full", t.parent ? "size-[6px]" : "size-[8px]")} style={{ background: colorOf.get(t.name) }} />
            {tableLabel(t, t.name)}
            <span className="font-mono text-[10.5px] text-ink-3">{t.record_count}</span>
          </button>
        ))}
        {f.view === "records" && (
          <>
            <span className="mx-1 h-4 w-px bg-line-strong" />
            {f.focus != null && (
              <span className="inline-flex h-7 items-center gap-1 rounded-md bg-ink pr-1 pl-2 text-[12px] text-surface">
                <Crosshair size={12} />
                <span className="max-w-[160px] truncate">{focusTitle ?? `#${f.focus}`}</span>
                {[1, 2, 3].map((d) => (
                  <button key={d} type="button" onClick={() => setF({ depth: d })} title={`${d} 跳以内`}
                    className={cx("rounded px-1.5 font-mono text-[11px]", d === f.depth ? "bg-surface text-ink" : "opacity-70 hover:opacity-100")}>{d}</button>
                ))}
                <button type="button" onClick={() => setF({ focus: null })} title="取消焦点" className="rounded p-0.5 opacity-70 hover:opacity-100"><X size={12} /></button>
              </span>
            )}
            <Menu label="连线" badge={offCount ? `${edges.length - offCount}/${edges.length}` : undefined}>
              {edges.map((e) => (
                <CheckRow key={e.key} on={!f.off.includes(e.key)} onClick={() => setF({ off: toggle(f.off, e.key) })}>{e.label}</CheckRow>
              ))}
            </Menu>
            <Menu label="操作者" badge={f.actors.length ? String(f.actors.length) : undefined}>
              {actors.map((a) => (
                <CheckRow key={a.name} on={f.actors.includes(a.name)} onClick={() => setF({ actors: toggle(f.actors, a.name) })}>
                  <span className="size-[7px] shrink-0 rounded-full" style={{ background: actorColor(a.name) }} />
                  <span className="truncate font-mono">{actorName(a.name)}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-3">{a.count} 条</span>
                </CheckRow>
              ))}
              {!actors.length && <div className="px-2 py-2 text-[12px] text-ink-3">当前范围里没有操作记录</div>}
              {f.actors.length > 0 && (
                <button type="button" onClick={() => setF({ actors: [] })} className="mt-1 w-full border-t border-line px-2 pt-1.5 pb-1 text-left text-[12px] text-ink-3 hover:text-ink">清除筛选</button>
              )}
            </Menu>
            <Seg value={f.since} options={[["", "全部时间"], ["1h", "1 小时"], ["24h", "24 小时"]]} onChange={(since) => setF({ since })} />
            <Seg value={f.color} options={[["table", "按表着色"], ["actor", "按操作者着色"]]} onChange={(color) => setF({ color })} />
          </>
        )}
      </div>
    </header>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex h-7 shrink-0 rounded-md border border-line-strong p-0.5">
      {options.map(([v, label]) => (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={cx("rounded px-2 text-[12px]", v === value ? "bg-ink text-surface" : "text-ink-2 hover:text-ink")}>{label}</button>
      ))}
    </div>
  );
}

function Menu({ label, badge, children }: { label: string; badge?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen(!open)} className={chip(true)}>
        {label}
        {badge && <span className="font-mono text-[10.5px] text-accent">{badge}</span>}
        <ChevronDown size={12} className="text-ink-3" />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={240}>
          <div className="p-1">{children}</div>
        </Popover>
      )}
    </>
  );
}

function CheckRow({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-raise">
      <span className={cx("flex size-[13px] shrink-0 items-center justify-center rounded-[3px] border", on ? "border-ink bg-ink" : "border-line-strong")}>
        {on && <span className="size-[5px] rounded-[1px] bg-surface" />}
      </span>
      {children}
    </button>
  );
}

function SearchBox({ search, onPick }: { search: (q: string) => SimNode[]; onPick: (n: SimNode) => void }) {
  const { byName } = useApp();
  const [q, setQ] = useState("");
  const results = q.trim() ? search(q.trim()) : [];
  const pick = (n: SimNode) => (onPick(n), setQ(""));
  return (
    <div className="relative flex h-8 w-[220px] items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 focus-within:border-accent">
      <Search size={13} className="shrink-0 text-ink-3" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" && results[0] ? pick(results[0]) : e.key === "Escape" && setQ(""))}
        placeholder="搜索记录，设为焦点"
        className="w-full bg-transparent outline-none placeholder:text-ink-3"
      />
      {results.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-line-strong bg-surface py-1 shadow-[var(--shadow)]">
          {results.map((n) => (
            <button key={n.id} type="button" onMouseDown={(e) => (e.preventDefault(), pick(n))}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-raise">
              <span className="min-w-0 flex-1 truncate">{n.title}</span>
              <span className="shrink-0 text-[11px] text-ink-3">{tableLabel(byName[n.table!], n.table!)}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-3">#{n.rid}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 画布底部的最近变更，点一下定位到对应节点。 */
export function ActivityBand({ items, onPick }: { items: ActivityItem[]; onPick: (a: ActivityItem) => void }) {
  if (!items.length) return null;
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 left-3 flex gap-1.5 overflow-x-auto pb-0.5">
      {items.map((a) => (
        <button key={a.seq} type="button" onClick={() => onPick(a)} title={`#${a.id}`}
          className="rise pointer-events-auto flex h-7 max-w-[300px] shrink-0 items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-[12px] shadow-[var(--shadow)] hover:border-ink-3">
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: actorColor(a.actor) }} />
          <span className="shrink-0 font-mono" style={{ color: actorColor(a.actor) }}>{actorName(a.actor)}</span>
          <span className={cx("shrink-0 text-ink-3", a.op === "delete" && "text-danger")}>{VERB[a.op]}</span>
          <span className={cx("truncate", a.op === "delete" && "text-ink-3 line-through")}>{a.title}</span>
          {a.fields.length > 0 && <span className="truncate text-ink-3">· {a.fields.join("、")}</span>}
        </button>
      ))}
    </div>
  );
}
