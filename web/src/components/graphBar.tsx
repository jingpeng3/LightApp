import { ChevronDown, Crosshair, History, Link2, Pause, Play, RefreshCw, Route, Search, X } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { HubItem, PathData, RelatedNode, TableInfo } from "../api";
import { api } from "../api";
import type { Filters, SimNode } from "../graphModel";
import { actorColor, actorName, cx, fieldLabel, tableLabel, toastError } from "../util";
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

export function GraphBar({ f, setF, stats, actors, linkFields, colorOf, focusTitle, focusCount, search, onReheat, replaying, onReplay, hubs }: {
  f: Filters;
  setF: (patch: Partial<Filters>) => void;
  stats: ReactNode;
  actors: { name: string; count: number }[];
  linkFields: { key: string; label: string }[];
  colorOf: Map<string, string>;
  focusTitle: string | null;
  /** 焦点关联到的记录数（不含焦点自己），还没加载完时为 null */
  focusCount: number | null;
  search: (q: string) => SimNode[];
  onReheat: () => void;
  replaying: boolean;
  onReplay: () => void;
  /** 枢纽菜单，放在记录图的筛选行里 */
  hubs: ReactNode;
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
          {f.view === "records" && (
            <Btn kind="line" onClick={onReplay} title={replaying ? "退出回放" : "历史回放：按变更顺序重演图是怎么长出来的"}
              className={cx("h-8", replaying && "border-accent text-accent")}><History size={14} /></Btn>
          )}
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
                {focusCount != null && <span className="font-mono text-[10.5px] opacity-70">+{focusCount}</span>}
                {([1, 2, 3, "all"] as const).map((d) => (
                  <button key={d} type="button" onClick={() => setF({ depth: d })} title={d === "all" ? "能连到的全部记录" : `${d} 跳以内`}
                    className={cx("rounded px-1.5 font-mono text-[11px]", d === f.depth ? "bg-surface text-ink" : "opacity-70 hover:opacity-100")}>{d === "all" ? "全部" : d}</button>
                ))}
                <button type="button" onClick={() => setF({ focus: null })} title="取消焦点" className="rounded p-0.5 opacity-70 hover:opacity-100"><X size={12} /></button>
              </span>
            )}
            {f.focus != null && (
              <Seg value={f.dir} options={[["both", "双向"], ["out", "它指向的"], ["in", "指向它的"]]} onChange={(dir) => setF({ dir })} />
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
            {hubs}
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
  const s = q.trim().replace(/^#/, "");
  const found = s ? search(s) : [];
  // 输入 _id 时即使它不在当前图里也能设为焦点
  const results = /^\d+$/.test(s) && !found.some((n) => n.rid === Number(s))
    ? [...found, { id: `r:${s}`, kind: "record" as const, rid: Number(s), title: `按 _id 定位 #${s}` }]
    : found;
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
              {n.table && <span className="shrink-0 text-[11px] text-ink-3">{tableLabel(byName[n.table], n.table)}</span>}
              <span className="shrink-0 font-mono text-[10.5px] text-ink-3">#{n.rid}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 画布底部的最近变更，点一下定位到对应节点。 */
export function ActivityBand({ items, onPick, lift }: { items: ActivityItem[]; onPick: (a: ActivityItem) => void; lift?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={cx("pointer-events-none absolute right-3 left-3 flex gap-1.5 overflow-x-auto pb-0.5", lift ? "bottom-15" : "bottom-3")}>
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

/** 焦点的关联记录，按跳数分组；每条说明是经哪条边、从哪条记录到达的。 */
export function RelatedList({ items, colorOf, selected, onPick }: {
  items: RelatedNode[];
  colorOf: Map<string, string>;
  selected: string | null;
  onPick: (r: { table: string; id: number }) => void;
}) {
  const { byName } = useApp();
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = new Map<number, RelatedNode[]>();
    for (const n of items) {
      if (n.depth === 0 || (s && !n.title.toLowerCase().includes(s) && !n.table.includes(s) && String(n.id) !== s.replace(/^#/, ""))) continue;
      if (!out.has(n.depth)) out.set(n.depth, []);
      out.get(n.depth)!.push(n);
    }
    return [...out].sort(([a], [b]) => a - b);
  }, [items, q]);
  const byId = useMemo(() => new Map(items.map((n) => [n.id, n])), [items]);
  // 「是 X 的子记录」「被 X 的某字段引用」这类说明；link 字段在边的 source 那张表上
  const via = (n: RelatedNode) => {
    const v = n.via!;
    const from = byId.get(v.from);
    const name = from?.title ?? `#${v.from}`;
    if (v.kind === "parent") return `${name} 的${v.dir === "out" ? "子记录" : "父记录"}`;
    return v.dir === "out"
      ? `被 ${name} 的「${fieldName(byName[from?.table ?? ""], v.field!)}」引用`
      : `通过「${fieldName(byName[n.table], v.field!)}」引用 ${name}`;
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="absolute top-3 right-3 h-7 rounded-md border border-line bg-panel px-2 text-[12px] shadow-[var(--shadow)] hover:border-ink-3">
        关联记录 {items.length - 1}
      </button>
    );
  }
  return (
    <aside className="absolute top-3 right-3 bottom-14 flex w-[280px] flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-[var(--shadow)]">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12.5px]">关联记录</span>
        <span className="font-mono text-[11px] text-ink-3">{items.length - 1}</span>
        <button type="button" onClick={() => setOpen(false)} title="收起" className="ml-auto rounded p-0.5 text-ink-3 hover:text-ink"><X size={13} /></button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="在结果里筛选"
        className="border-b border-line bg-transparent px-3 py-1.5 text-[12px] outline-none placeholder:text-ink-3" />
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {groups.map(([d, ns]) => (
          <section key={d}>
            <h4 className="px-3 pt-2 pb-1 font-mono text-[10.5px] text-ink-3">{d} 跳 · {ns.length}</h4>
            {ns.map((n) => (
              <button key={n.id} type="button" onClick={() => onPick(n)}
                className={cx("flex w-full flex-col px-3 py-1 text-left hover:bg-raise", selected === `r:${n.id}` && "bg-raise")}>
                <span className="flex w-full items-center gap-1.5">
                  <span className="size-[7px] shrink-0 rounded-full" style={{ background: colorOf.get(n.table) }} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{n.title}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-3">#{n.id}</span>
                </span>
                <span className="truncate pl-[13px] text-[11px] text-ink-3">{tableLabel(byName[n.table], n.table)} · {via(n)}</span>
              </button>
            ))}
          </section>
        ))}
        {!groups.length && <div className="px-3 py-3 text-[12px] text-ink-3">{items.length > 1 ? "没有匹配的记录" : "这条记录没有关联"}</div>}
      </div>
    </aside>
  );
}

function fieldName(table: TableInfo | undefined, key: string) {
  const f = table?.fields.find((x) => x.key === key);
  return f ? fieldLabel(f) : key;
}

/** 两点之间的路径，逐段显示经过的记录和边。 */
export function PathBar({ path, onPick, onClose }: { path: PathData; onPick: (r: { table: string; id: number }) => void; onClose: () => void }) {
  const { byName } = useApp();
  return (
    <div className="absolute top-3 left-3 flex max-w-[calc(100%-320px)] flex-wrap items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-[var(--shadow)]">
      <Route size={13} className="shrink-0 text-accent" />
      <span className="mr-1 text-ink-3">{path.edges.length} 步</span>
      {path.nodes.map((n, i) => {
        const e = path.edges[i - 1];
        const owner = e && byName[path.nodes[e.dir === "out" ? i - 1 : i].table];
        return (
          <span key={n.id} className="inline-flex items-center gap-1">
            {e && (
              <span className="font-mono text-[10.5px] text-ink-3">
                {e.dir === "in" ? "←" : ""}{e.kind === "parent" ? "父子" : fieldName(owner, e.field!)}{e.dir === "out" ? "→" : ""}
              </span>
            )}
            <button type="button" onClick={() => onPick(n)} className="max-w-[140px] truncate rounded px-1 hover:bg-raise hover:text-accent">{n.title}</button>
          </span>
        );
      })}
      <button type="button" onClick={onClose} title="关闭路径" className="ml-1 rounded p-0.5 text-ink-3 hover:text-ink"><X size={12} /></button>
    </div>
  );
}

export interface Replay {
  /** 整张快照对应的 seq；变了就按它重新拉图 */
  snap: number;
  /** 当前显示到哪条变更；播放时逐条应用变更，只改它不改 snap */
  at: number;
  ts: string | null;
  first: number;
  last: number;
  playing: boolean;
}

/** 历史回放：拖动时间轴看某一刻的图，播放时按变更顺序逐条重演。 */
export function ReplayBar({ replay, onSeek, onPlay, onClose }: {
  replay: Replay;
  onSeek: (seq: number) => void;
  onPlay: (playing: boolean) => void;
  onClose: () => void;
}) {
  const { first, last, at, ts, playing } = replay;
  const min = Math.max(0, first - 1);
  const end = at >= last;
  return (
    <div className="absolute right-3 bottom-3 left-3 flex h-10 items-center gap-2.5 rounded-lg border border-line bg-panel px-2.5 text-[12px] shadow-[var(--shadow)]">
      <History size={14} className="shrink-0 text-accent" />
      <button type="button" onClick={() => onPlay(!playing)} disabled={!playing && end && first === 0}
        title={playing ? "暂停" : end ? "从头播放" : "播放"} className="rounded p-1 text-ink-2 hover:bg-raise hover:text-ink">
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <input type="range" min={min} max={Math.max(last, min)} value={Math.min(Math.max(at, min), Math.max(last, min))}
        onChange={(e) => onSeek(Number(e.target.value))} className="min-w-0 flex-1 accent-[var(--accent)]" />
      <span className="shrink-0 font-mono text-[11px] text-ink-3">
        {at < first ? "开始之前" : `seq ${at}`}{ts ? ` · ${new Date(ts).toLocaleString()}` : ""}
      </span>
      <button type="button" onClick={onClose} title="退出回放，回到现在" className="rounded p-0.5 text-ink-3 hover:text-ink"><X size={13} /></button>
    </div>
  );
}

/** 连接最多的记录，打开时按当前表范围和连线开关现查。 */
export function HubsMenu({ tables, kinds, colorOf, onPick }: {
  tables: string | undefined;
  kinds: string | undefined;
  colorOf: Map<string, string>;
  onPick: (r: { table: string; id: number }) => void;
}) {
  const { byName } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HubItem[] | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const show = () => {
    setOpen(!open);
    if (open) return;
    setItems(null);
    api.hubs({ tables, kinds, limit: 15 }).then((r) => setItems(r.items), toastError);
  };
  return (
    <>
      <button ref={ref} type="button" onClick={show} className={chip(true)} title="连接最多的记录">
        枢纽 <ChevronDown size={12} className="text-ink-3" />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={280}>
          <div className="p-1">
            {items?.map((h) => (
              <button key={h.id} type="button" onClick={() => (setOpen(false), onPick(h))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-raise">
                <span className="size-[7px] shrink-0 rounded-full" style={{ background: colorOf.get(h.table) }} />
                <span className="min-w-0 flex-1 truncate">{h.title}</span>
                <span className="shrink-0 text-[11px] text-ink-3">{tableLabel(byName[h.table], h.table)}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-ink-3" title={`指向它 ${h.in} · 它发出 ${h.out}`}>{h.degree}</span>
              </button>
            ))}
            {items && !items.length && <div className="px-2 py-2 text-[12px] text-ink-3">当前范围里没有关联</div>}
            {!items && <div className="px-2 py-2 text-[12px] text-ink-3">加载中…</div>}
          </div>
        </Popover>
      )}
    </>
  );
}

export interface LinkChoice {
  key: string;
  /** 持有 link 字段的记录，和它要指向的记录 */
  holder: { table: string; id: number; version: number };
  field: string;
  target: number;
  multiple: boolean;
  label: string;
  /** 单值 link 已经指向别的记录时，选它会替换掉 */
  replaces: number | null;
  /** 已经引用了目标，不需要再加 */
  exists: boolean;
}

/** 拖线松手后，在落点旁边选用哪个 link 字段建立关联。 */
export function LinkMenu({ x, y, from, to, choices, onChoose, onClose }: {
  x: number;
  y: number;
  from: string;
  to: string;
  choices: LinkChoice[] | null;
  onChoose: (c: LinkChoice) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute z-30 w-[260px] rounded-lg border border-line-strong bg-surface p-1 text-[12.5px] shadow-[var(--shadow)]"
      style={{ left: Math.max(8, x + 12), top: Math.max(8, y + 12) }}>
      <div className="flex items-center gap-1 px-2 pt-1 pb-1.5 text-[11.5px] text-ink-3">
        <span className="truncate">{from}</span><span className="shrink-0">→</span><span className="truncate">{to}</span>
        <button type="button" onClick={onClose} title="取消" className="ml-auto shrink-0 rounded p-0.5 hover:text-ink"><X size={12} /></button>
      </div>
      {choices?.map((c) => (
        <button key={c.key} type="button" disabled={c.exists} onClick={() => onChoose(c)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raise disabled:text-ink-3 disabled:hover:bg-transparent">
          <Link2 size={12} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate">{c.label}</span>
          {c.exists && <span className="shrink-0 text-[11px]">已关联</span>}
          {c.replaces != null && !c.exists && <span className="shrink-0 text-[11px] text-warn">替换 #{c.replaces}</span>}
        </button>
      ))}
      {!choices && <div className="px-2 py-1.5 text-ink-3">读取记录…</div>}
    </div>
  );
}
