import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { Change, GraphData, TableInfo } from "../api";
import { api } from "../api";
import { drawNode, linkColor, linkWidth, PULSE_MS, radius, readPalette, solid, TABLE_COLORS, type DrawCtx } from "../graphDraw";
import {
  applyChange, curve, endId, FADE_MS, fromData, purge, readFilters, visible, writeFilters,
  type Filters, type Model, type SimLink, type SimNode,
} from "../graphModel";
import { useChanges } from "../live";
import { actorColor, actorName, fieldLabel, recTitle, relTime, tableLabel, toast, toastError } from "../util";
import { ActivityBand, GraphBar, type ActivityItem, type Pulse } from "./graphBar";
import { Empty, useApp } from "./ui";

const LIMIT = 3000;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 表概览：表是节点，父子和 link 字段是边，边的条数来自接口的 table_edges。 */
function tableGraph(tables: TableInfo[], data: GraphData | null, reuse: Map<string, SimNode>) {
  const count = new Map((data?.table_edges ?? []).map((e) => [`${e.kind}:${e.source}>${e.target}:${e.field ?? ""}`, e.count]));
  const nodes = tables.map((t) => {
    const id = `t:${t.name}`;
    const n = reuse.get(id) ?? { id, kind: "table" as const, title: "" };
    Object.assign(n, { table: t.name, title: tableLabel(t, t.name), count: t.record_count, child: !!t.parent });
    reuse.set(id, n);
    return n;
  });
  const links: SimLink[] = [];
  for (const t of tables) {
    if (t.parent) {
      const k = `parent:${t.parent}>${t.name}:`;
      links.push({ key: k, source: `t:${t.parent}`, target: `t:${t.name}`, kind: "parent", count: count.get(k) ?? 0 });
    }
    for (const f of t.fields) {
      if (f.type !== "link" || !f.config?.table) continue;
      const k = `link:${t.name}>${f.config.table}:${f.key}`;
      links.push({ key: k, source: `t:${t.name}`, target: `t:${f.config.table}`, kind: "link", field: f.key, owner: t.name, count: count.get(k) ?? 0 });
    }
  }
  curve(links);
  return { nodes, links, missingFocus: false };
}

export function GraphView({ qs }: { qs: string }) {
  const { domain, tables, byName, openRecord } = useApp();
  // 默认视图只按进入页面时的记录数决定，之后记录增减不会让视图跳来跳去
  const [initialTotal] = useState(() => tables.reduce((s, t) => s + t.record_count, 0));
  const f = useMemo(() => readFilters(qs, initialTotal), [qs, initialTotal]);
  const setF = useCallback((patch: Partial<Filters>) => {
    location.hash = `${encodeURIComponent(domain)}/@graph?${writeFilters({ ...f, ...patch })}`;
  }, [f, domain]);
  const scope = f.tables?.filter((t) => byName[t]) ?? null;
  const scopeKey = scope?.join(",") ?? "*";

  const model = useRef<Model | null>(null);
  const pending = useRef<Change[] | null>(null);
  const tableNodes = useRef(new Map<string, SimNode>());
  const [tableData, setTableData] = useState<GraphData | null>(null);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const byNameRef = useRef(byName);
  byNameRef.current = byName;
  const fit = useRef(true);

  useEffect(() => {
    let alive = true;
    pending.current = [];
    setLoading(true);
    const params = f.view === "tables" ? { limit: 0 } : { tables: scope?.join(","), limit: LIMIT };
    api.graph(params).then((data) => {
      if (!alive) return;
      if (f.view === "tables") setTableData(data);
      else {
        const m = fromData(data);
        for (const n of m.nodes.values()) n.child = !!byNameRef.current[n.table!]?.parent;
        for (const c of pending.current ?? []) applyChange(m, c, byNameRef.current, Date.now());
        model.current = m;
      }
      pending.current = null;
      fit.current = true;
      setLoading(false);
      setVersion((v) => v + 1);
    }, (e) => alive && (toastError(e), setLoading(false)));
    return () => void (alive = false);
    // scope 用 scopeKey 表示，避免数组引用变化导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.view, scopeKey, reload]);

  // 换了筛选范围后重新适配视野；只改着色不动视野
  const shapeKey = [f.view, scopeKey, f.focus, f.depth, f.off.join(), f.actors.join(), f.since].join("|");
  useEffect(() => void (fit.current = true), [shapeKey]);

  // 有动画时持续重绘；没有时让 force-graph 在布局稳定后停下来省电
  const [anim, setAnim] = useState(false);
  const animTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const animate = () => {
    setAnim(true);
    clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => setAnim(false), PULSE_MS + 100);
  };
  useEffect(() => () => clearTimeout(animTimer.current), []);

  const pulses = useRef(new Map<string, Pulse>());
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const tableTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(tableTimer.current), []);

  useChanges((c) => {
    if (c.op === "create_table" || c.op === "alter_table" || c.op === "drop_table") return setReload((r) => r + 1);
    if (c.record_id == null || !["insert", "update", "delete"].includes(c.op)) return;
    if (f.view === "tables") {
      clearTimeout(tableTimer.current);
      tableTimer.current = setTimeout(() => setReload((r) => r + 1), 1000);
      return;
    }
    if (scope && !scope.includes(c.table_name)) return;
    if (pending.current) return void pending.current.push(c);
    const m = model.current;
    if (!m) return;
    const now = Date.now();
    const eff = applyChange(m, c, byName, now);
    if (!eff) return;
    const table = byName[c.table_name];
    const fields = eff.fields.map((k) => {
      const fd = table?.fields.find((x) => x.key === k);
      return fd ? fieldLabel(fd) : k;
    });
    pulses.current.set(eff.id, { t: now, actor: c.actor, op: c.op, fields });
    setTimeout(() => pulses.current.get(eff.id)?.t === now && pulses.current.delete(eff.id), PULSE_MS + 200);
    setActivity((xs) => [{ seq: c.seq, table: c.table_name, id: c.record_id!, title: recTitle(table, c.after ?? c.before), t: now, actor: c.actor, op: c.op, fields }, ...xs].slice(0, 20));
    animate();
    if (eff.structural) setVersion((v) => v + 1);
    if (eff.dying) setTimeout(() => model.current === m && purge(m, Date.now()) && setVersion((v) => v + 1), FADE_MS + 50);
  });

  const graph = useMemo(() => {
    if (f.view === "tables") return tableGraph(tables, tableData, tableNodes.current);
    return model.current ? visible(model.current, f) : { nodes: [], links: [], missingFocus: false };
    // version 代表 model 内部变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, f, tableData, f.view === "tables" ? tables : null]);

  // 筛选变化后，之前选中的节点可能已经不在图里
  const [selected, setSelected] = useState<string | null>(null);
  const near = useMemo(() => {
    if (!selected || !graph.nodes.some((n) => n.id === selected)) return null;
    const s = new Set([selected]);
    for (const l of graph.links) {
      const a = endId(l.source), b = endId(l.target);
      if (a === selected) s.add(b);
      if (b === selected) s.add(a);
    }
    return s;
  }, [selected, graph]);
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const ob = new MutationObserver(() => setPalette(readPalette()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => ob.disconnect();
  }, []);

  const colorOf = useMemo(() => new Map(tables.map((t, i) => [t.name, TABLE_COLORS[i % TABLE_COLORS.length]])), [tables]);
  // 连接数前 15 的记录常驻标题
  const labelDeg = useMemo(() => {
    const degs = graph.nodes.filter((n) => n.kind === "record").map((n) => n.deg ?? 0).sort((a, b) => b - a);
    return Math.max(3, (degs[14] ?? 0) + 1);
  }, [graph]);
  const draw = useMemo<DrawCtx>(() => ({
    palette,
    tableColor: (name) => (name && colorOf.get(name)) || palette.ink3,
    color: (n) => n.kind === "actor" ? solid(actorColor(n.title), palette)
      : f.color === "actor" && n.kind === "record" ? solid(actorColor(n.updated_by), palette)
        : colorOf.get(n.table!) ?? palette.ink3,
    selected: near ? selected : null,
    near,
    pulses: pulses.current,
    labelDeg,
  }), [palette, colorOf, f.color, selected, near, labelDeg]);

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fg = useRef<ForceGraphMethods<SimNode, SimLink>>(undefined);
  const mounted = size.w > 0;
  // 布局要几秒才停；先在 1 秒时粗略适配一次，停下后再精确适配
  useEffect(() => {
    if (!fit.current || loading) return;
    const t = setTimeout(() => fit.current && fg.current?.zoomToFit(400, 48), 1000);
    return () => clearTimeout(t);
  }, [shapeKey, loading, mounted]);
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    const tablesView = f.view === "tables";
    g.d3Force("link")?.distance((l: SimLink) => (tablesView ? 140 : l.kind === "parent" ? 26 : l.kind === "actor" ? 80 : 55));
    g.d3Force("charge")?.strength(tablesView ? -600 : -40).distanceMax(tablesView ? 1000 : 320);
    g.d3ReheatSimulation();
  }, [f.view, mounted]);

  const lastClick = useRef({ id: "", t: 0 });
  const onNodeClick = (n: SimNode) => {
    if (n.kind === "table") return setF({ view: "records", tables: [n.table!], focus: null });
    if (n.kind === "actor") return setF({ actors: f.actors.includes(n.title) ? f.actors.filter((x) => x !== n.title) : [...f.actors, n.title] });
    const dbl = lastClick.current.id === n.id && Date.now() - lastClick.current.t < 350;
    lastClick.current = { id: n.id, t: Date.now() };
    if (dbl) return setF({ focus: n.rid! });
    setSelected(n.id);
    if (n.dying == null) openRecord({ table: n.table!, id: n.rid! });
  };

  const locate = (a: ActivityItem) => {
    const n = graph.nodes.find((x) => x.id === `r:${a.id}`);
    if (!n || n.x == null) return toast("info", a.op === "delete" ? "这条记录已经删除" : "这条记录不在当前筛选范围里");
    setSelected(n.id);
    fg.current?.centerAt(n.x, n.y, 500);
    fg.current?.zoom(Math.max(2.5, fg.current.zoom()), 500);
  };

  const search = (q: string) => {
    const m = model.current;
    if (!m) return [];
    const s = q.toLowerCase().replace(/^#/, "");
    const out: SimNode[] = [];
    for (const n of m.nodes.values()) {
      if (n.dying == null && (String(n.rid) === s || n.title.toLowerCase().includes(s))) out.push(n);
      if (out.length >= 8) break;
    }
    return out;
  };

  const actors = [...(model.current?.touches ?? [])]
    .map(([name, map]) => ({ name, count: map.size }))
    .filter((a) => a.count > 0)
    .sort((a, b) => b.count - a.count);
  const linkFields = tables
    .filter((t) => !scope || scope.includes(t.name))
    .flatMap((t) => t.fields.filter((x) => x.type === "link").map((x) => ({ key: `link:${t.name}.${x.key}`, label: `${tableLabel(t, t.name)}.${fieldLabel(x)}` })));

  const m = model.current;
  const records = graph.nodes.filter((n) => n.kind === "record").length;
  const stats = f.view === "tables"
    ? `${tables.length} 张表 · ${tables.reduce((s, t) => s + t.record_count, 0)} 条记录 · 点一张表查看它的记录`
    : <>
        {records} 条记录 · {graph.links.length} 条连线
        {m?.truncated && <span className="text-warn"> · 记录太多，只加载了最近更新的 {LIMIT} 条，先选表或设焦点</span>}
        {graph.missingFocus && <span className="text-warn"> · 焦点记录不在当前范围里</span>}
        {f.view === "records" && <span> · 单击查看数据，双击设为焦点</span>}
      </>;

  const tablesView = f.view === "tables";
  const linkLabel = (l: SimLink) => {
    const n = tablesView ? ` · ${l.count} 条` : "";
    if (l.kind === "actor") return esc(`${actorName(endId(l.source).slice(2))} 写入 ${l.count} 次`);
    if (l.kind === "parent") return esc(`父子${n}`);
    const t = byName[l.owner!];
    const fd = t?.fields.find((x) => x.key === l.field);
    return esc(`${tableLabel(t, l.owner!)}.${fd ? fieldLabel(fd) : l.field}${n}`);
  };
  const nodeLabel = (n: SimNode) => {
    if (n.kind === "actor") return esc(`操作者 ${actorName(n.title)} · 点击按它筛选`);
    if (n.kind === "table") return esc(`${n.title} · ${n.count} 条记录`);
    const t = tableLabel(byName[n.table!], n.table!);
    return `<b>${esc(n.title)}</b><br/>${esc(`${t} #${n.rid}`)}<br/>${esc(`${actorName(n.updated_by)} 更新于 ${n.updated_at ? relTime(n.updated_at) : "?"}`)}`;
  };

  return (
    <>
      <GraphBar
        f={f}
        setF={setF}
        stats={stats}
        actors={actors}
        linkFields={linkFields}
        colorOf={colorOf}
        focusTitle={f.focus != null ? m?.nodes.get(`r:${f.focus}`)?.title ?? null : null}
        search={search}
        onReheat={() => ((fit.current = true), fg.current?.d3ReheatSimulation())}
      />
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden border-t border-line bg-surface">
        {mounted && (
          <ForceGraph2D<SimNode, SimLink>
            ref={fg}
            width={size.w}
            height={size.h}
            graphData={graph}
            nodeId="id"
            nodeVal={(n) => (radius(n) / 4) ** 2}
            nodeLabel={nodeLabel}
            nodeCanvasObject={(n, ctx, scale) => drawNode(n, ctx, scale, draw)}
            linkColor={(l) => linkColor(l, draw)}
            linkWidth={(l) => linkWidth(l, draw, tablesView)}
            linkLineDash={(l) => (l.kind === "link" ? [3, 2] : null)}
            linkCurvature="curvature"
            linkLabel={linkLabel}
            linkDirectionalArrowLength={(l) => (l.kind === "link" ? (tablesView ? 6 : 3.5) : 0)}
            linkDirectionalArrowRelPos={1}
            autoPauseRedraw={!anim}
            cooldownTime={8000}
            onNodeClick={onNodeClick}
            onBackgroundClick={() => setSelected(null)}
            onEngineStop={() => fit.current && ((fit.current = false), fg.current?.zoomToFit(400, 48))}
          />
        )}
        {!loading && !graph.nodes.length && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Empty title={tables.length ? "没有可显示的记录" : "这里还空着"}>
              {tables.length ? "换一组表，或者放宽操作者、时间、焦点筛选。" : "域里还没有表。让 agent 用 dt-schema skill 建表，图谱会自动生成。"}
            </Empty>
          </div>
        )}
        {loading && <div className="absolute top-3 left-4 text-[12px] text-ink-3">加载图谱…</div>}
        {!tablesView && <ActivityBand items={activity} onPick={locate} />}
      </div>
    </>
  );
}
