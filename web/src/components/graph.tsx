import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { Change, GraphData, PathData, RelatedNode, TableInfo } from "../api";
import { api, ApiError } from "../api";
import { drawDragLine, drawNode, linkColor, linkWidth, PULSE_MS, radius, readPalette, solid, TABLE_COLORS, type DrawCtx } from "../graphDraw";
import {
  applyChange, curve, edgeKey, endId, FADE_MS, fromData, purge, readFilters, relatesTo, touchesMatch, visible, writeFilters,
  type Filters, type Model, type SimLink, type SimNode,
} from "../graphModel";
import { useChanges } from "../live";
import { actorColor, actorName, asList, fieldLabel, recTitle, relTime, tableLabel, toast, toastError } from "../util";
import {
  ActivityBand, GraphBar, HubsMenu, LinkMenu, PathBar, RelatedList, ReplayBar,
  type ActivityItem, type LinkChoice, type Pulse, type Replay,
} from "./graphBar";
import { Empty, useApp } from "./ui";

const LIMIT = 3000;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 表概览：表是节点，父子、link 字段和同值关联是边，边的条数来自接口的 table_edges；同值关联只画有边的表对。 */
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
  for (const e of data?.table_edges ?? []) {
    if (e.kind === "match") links.push({ key: `match:${e.source}>${e.target}:${e.match}`, source: `t:${e.source}`, target: `t:${e.target}`, kind: "match", match: e.match, count: e.count });
  }
  curve(links);
  return { nodes, links };
}

/** 重新拉图后沿用旧节点对象，已有记录的布局位置不变。 */
function keepLayout(prev: Model | null, next: Model) {
  if (!prev) return;
  for (const [id, n] of next.nodes) {
    const old = prev.nodes.get(id);
    if (old) next.nodes.set(id, Object.assign(old, n, { dying: undefined }));
  }
  next.actors = prev.actors;
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
  const linkFields = tables
    .filter((t) => !scope || scope.includes(t.name))
    .flatMap((t) => t.fields.filter((x) => x.type === "link").map((x) => ({ key: `link:${t.name}.${x.key}`, label: `${tableLabel(t, t.name)}.${fieldLabel(x)}` })));
  // 同值关联按 config.match 的名字开关，至少两个字段声明了同一个名字、或字段写了 self 才有边
  const matchFields = tables
    .filter((t) => !scope || scope.includes(t.name))
    .flatMap((t) => t.fields.filter((x) => x.config?.match));
  const matchNames = matchFields.map((x) => x.config!.match!);
  const matchKinds = [...new Set(matchNames.filter((x, i) => matchNames.indexOf(x) !== i || matchFields[i].config?.self))]
    .map((x) => ({ key: `match:${x}`, label: `同值 · ${x}` }));
  const edgeKinds = [...linkFields, ...matchKinds];
  // 焦点沿「连线」里打开的边遍历；全部打开时不传 kinds
  const traversal = ["parent", ...edgeKinds.map((x) => x.key)];
  const walk = traversal.filter((k) => !f.off.includes(k));
  const kinds = walk.length === traversal.length ? undefined : walk.join(",");
  // 回放时图由 dt_changes 还原，焦点（接口按现在的数据算）不生效
  const [replay, setReplay] = useState<Replay | null>(null);
  // 最近一次加载完成的图对应哪个回放快照（不在回放时为 null）；播放要等快照到位再开始
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const focusing = f.view === "records" && f.focus != null && !replay;
  const focusKey = focusing ? [f.focus, f.depth, f.dir, kinds ?? "*"].join("|") : "";

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
  // 焦点模式下关联记录变化后静默重拉：不显示加载、不重新适配视野
  const soft = useRef(false);
  // 回放换快照、退出回放也是静默重拉，但图换了一批记录，加载完要重新适配视野
  const refit = useRef(false);
  const [related, setRelated] = useState<RelatedNode[] | null>(null);
  const [missingFocus, setMissingFocus] = useState(false);

  useEffect(() => {
    let alive = true;
    const quiet = soft.current;
    soft.current = false;
    pending.current = [];
    if (!quiet) setLoading(true);
    const load: Promise<Parameters<typeof fromData>[0] & { nodes: GraphData["nodes"] | RelatedNode[] }> =
      f.view === "tables" ? api.graph({ limit: 0 })
        : focusing ? api.related({ ids: f.focus!, depth: walk.length ? f.depth : 0, direction: f.dir, kinds, tables: scope?.join(","), limit: LIMIT })
          .then((r) => ({ ...r, total: r.nodes.length }))
          : api.graph({ tables: scope?.join(","), limit: LIMIT, at: replay?.snap });
    load.then((data) => {
      if (!alive) return;
      if (f.view === "tables") setTableData(data as GraphData);
      else {
        const m = fromData(data);
        for (const n of m.nodes.values()) n.child = !!byNameRef.current[n.table!]?.parent;
        if (!replay) for (const c of pending.current ?? []) if (!focusing || relatesTo(m, c, byNameRef.current)) applyChange(m, c, byNameRef.current, Date.now());
        keepLayout(model.current, m);
        model.current = m;
        setRelated(focusing ? (data.nodes as RelatedNode[]) : null);
        const tl = (data as GraphData).timeline;
        const snap = replay?.snap ?? null;
        if (replay && tl) {
          setReplay((r) => r && r.snap === snap
            ? { ...r, ts: r.at === snap ? tl.at_ts : r.ts, first: tl.first_seq, last: Math.max(r.last, tl.last_seq) } : r);
        }
        setLoadedAt(snap);
      }
      setMissingFocus(false);
      pending.current = null;
      if (!quiet) fit.current = true;
      if (refit.current) {
        refit.current = false;
        fit.current = true;
        setTimeout(() => fit.current && fg.current?.zoomToFit(400, 48), 700);
      }
      setLoading(false);
      setVersion((v) => v + 1);
    }, (e) => {
      if (!alive) return;
      pending.current = null;
      setLoading(false);
      if (focusing && e instanceof ApiError && e.code === "not_found") {
        model.current = fromData({ seq: 0, total: 0, truncated: false, nodes: [], edges: [], touches: [] });
        setRelated(null);
        setMissingFocus(true);
        setVersion((v) => v + 1);
      } else toastError(e);
    });
    return () => void (alive = false);
    // scope、kinds 分别用 scopeKey、focusKey 表示，避免数组引用变化导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.view, scopeKey, focusKey, reload, replay?.snap ?? null]);

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
  const refetch = () => {
    clearTimeout(tableTimer.current);
    tableTimer.current = setTimeout(() => ((soft.current = true), setReload((r) => r + 1)), 800);
  };

  useChanges((c) => {
    if (c.op === "create_table" || c.op === "alter_table" || c.op === "drop_table") {
      setReplay(null);
      return setReload((r) => r + 1);
    }
    if (c.record_id == null || !["insert", "update", "delete"].includes(c.op)) return;
    // 回放时不应用实时变更，只让时间轴的终点跟上
    if (replay) return setReplay((r) => r && { ...r, last: Math.max(r.last, c.seq) });
    if (f.view === "tables") {
      clearTimeout(tableTimer.current);
      tableTimer.current = setTimeout(() => setReload((r) => r + 1), 1000);
      return;
    }
    if (scope && !scope.includes(c.table_name)) return;
    if (pending.current) return void pending.current.push(c);
    const m = model.current;
    if (!m) return;
    // 焦点模式只含关联记录：相关的变更先在图上表现出来，再按接口重算关联范围；同值关联由接口计算，有变化时也重拉
    const matched = touchesMatch(c, byName[c.table_name]);
    if (focusing) {
      if (!matched && !relatesTo(m, c, byName)) return;
      refetch();
    } else if (matched) refetch();
    show(m, c);
  });

  /** 把一条记录变更画到图上：节点脉冲、活动带、结构变化时重新生成 graphData。实时和回放共用。 */
  const show = (m: Model, c: Change) => {
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
  };
  const showRef = useRef(show);
  showRef.current = show;

  // ---------- 历史回放 ----------
  const startReplay = () => {
    if (replay) return stopReplay();
    const seq = model.current?.seq ?? 0;
    soft.current = refit.current = true;
    setActivity([]);
    setPath(null);
    setReplay({ snap: seq, at: seq, ts: null, first: 0, last: seq, playing: false });
  };
  const stopReplay = () => {
    soft.current = refit.current = true;
    setActivity([]);
    setReplay(null);
  };
  // 拖动时间轴：显示立刻跟上，停手 250ms 后再按新位置拉快照
  const seekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(seekTimer.current), []);
  const seek = (seq: number) => {
    setReplay((r) => r && { ...r, at: seq, ts: null, playing: false });
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => {
      soft.current = refit.current = true;
      setActivity([]);
      setReplay((r) => r && { ...r, snap: seq });
      // 快照 seq 没变（例如播放后拖回起点）时也要重拉
      setReload((x) => x + 1);
    }, 250);
  };
  const play = (on: boolean) => {
    const r = replay;
    if (!r) return;
    clearTimeout(seekTimer.current);
    if (!on) return setReplay({ ...r, playing: false });
    // 在终点时从头播放；图停在别的位置（拖动过、播放过）时先按起点重新拉快照，再接着播
    const snap = r.at >= r.last ? Math.max(0, r.first - 1) : r.at;
    if (snap !== r.at || snap !== r.snap) {
      soft.current = refit.current = true;
      setActivity([]);
      setLoadedAt(null);
      setReload((x) => x + 1);
    }
    setReplay({ ...r, snap, at: snap, playing: true });
  };
  // 播放：快照加载完后从当前位置起逐条拉取变更，每条记录变更停一会儿，让动画看得清
  useEffect(() => {
    if (!replay?.playing || loadedAt !== replay.snap) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buf: Change[] = [];
    let cursor = replay.at;
    let ended = false;
    const stop = () => setReplay((r) => r && { ...r, playing: false });
    const tick = async () => {
      if (!buf.length && !ended) {
        const cs = await api.changes({ since: cursor, limit: 200 }).catch((e) => (toastError(e), null));
        if (!alive) return;
        if (!cs) return stop();
        buf = cs;
        ended = cs.length < 200;
        if (cs.length) cursor = cs[cs.length - 1].seq;
      }
      const c = buf.shift();
      if (!c) return stop();
      const m = model.current;
      const record = c.record_id != null && ["insert", "update", "delete"].includes(c.op) && !!byNameRef.current[c.table_name]
        && (!scope || scope.includes(c.table_name));
      if (m && record) showRef.current(m, c);
      else if (m) m.seq = Math.max(m.seq, c.seq);
      setReplay((r) => r && { ...r, at: c.seq, ts: c.ts, last: Math.max(r.last, c.seq) });
      timer = setTimeout(tick, record ? 450 : 0);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // 只在开始 / 暂停 / 快照加载完成时重启；播放过程中 at 的变化由循环自己推进
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.playing, loadedAt, replay?.snap]);
  // 换表范围或切到表概览时退出回放
  useEffect(() => void setReplay(null), [scopeKey, f.view]);

  const graph = useMemo(() => {
    if (f.view === "tables") return tableGraph(tables, tableData, tableNodes.current);
    return model.current ? visible(model.current, f) : { nodes: [], links: [] };
    // version 代表 model 内部变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, f, tableData, f.view === "tables" ? tables : null]);

  // 两点路径：选中一个节点后 Shift+单击另一个节点
  const [path, setPath] = useState<PathData | null>(null);
  const pathEdges = useMemo(() => (path?.found ? new Set(path.edges.map(edgeKey)) : null), [path]);
  useEffect(() => setPath(null), [shapeKey]);

  // 筛选变化后，之前选中的节点可能已经不在图里
  const [selected, setSelected] = useState<string | null>(null);
  const near = useMemo(() => {
    if (path?.found) return new Set(path.nodes.map((n) => `r:${n.id}`));
    if (!selected || !graph.nodes.some((n) => n.id === selected)) return null;
    const s = new Set([selected]);
    for (const l of graph.links) {
      const a = endId(l.source), b = endId(l.target);
      if (a === selected) s.add(b);
      if (b === selected) s.add(a);
    }
    return s;
  }, [selected, graph, path]);
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
    path: pathEdges,
    pulses: pulses.current,
    labelDeg,
  }), [palette, colorOf, f.color, selected, near, pathEdges, labelDeg]);

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

  const findPath = (from: SimNode, to: SimNode) => {
    api.path({ source: from.rid!, target: to.rid!, kinds }).then((p) => {
      setPath(p);
      if (!p.found) toast("info", `「${from.title}」和「${to.title}」之间没有关联路径`, "只沿「连线」里打开的边查找");
      else if (p.nodes.some((n) => !model.current?.nodes.has(`r:${n.id}`))) toast("info", "路径经过了当前图里没有的记录", "在上方的路径栏里可以点开它们");
    }, toastError);
  };

  const lastClick = useRef({ id: "", t: 0 });
  const onNodeClick = (n: SimNode, e: MouseEvent) => {
    if (n.kind === "table") return setF({ view: "records", tables: [n.table!], focus: null });
    if (n.kind === "actor") return setF({ actors: f.actors.includes(n.title) ? f.actors.filter((x) => x !== n.title) : [...f.actors, n.title] });
    const from = selected ? model.current?.nodes.get(selected) : undefined;
    if (e.shiftKey && from && from.id !== n.id) return findPath(from, n);
    const dbl = lastClick.current.id === n.id && Date.now() - lastClick.current.t < 350;
    lastClick.current = { id: n.id, t: Date.now() };
    if (dbl) return setF({ focus: n.rid! });
    setPath(null);
    setSelected(n.id);
    if (n.dying == null) openRecord({ table: n.table!, id: n.rid! });
  };

  /** 定位到图上的记录；不在图里时返回 false。 */
  const center = (id: number) => {
    const n = graph.nodes.find((x) => x.id === `r:${id}`);
    if (!n || n.x == null) return false;
    setSelected(n.id);
    fg.current?.centerAt(n.x, n.y, 500);
    fg.current?.zoom(Math.max(2.5, fg.current.zoom()), 500);
    return true;
  };
  const locate = (a: ActivityItem) => {
    if (!center(a.id)) toast("info", a.op === "delete" ? "这条记录已经删除" : "这条记录不在当前筛选范围里");
  };
  const pick = (r: { table: string; id: number }) => {
    if (!center(r.id)) setSelected(null);
    openRecord({ table: r.table, id: r.id });
  };

  // ---------- 拖线建 link：按住 Alt 把一条记录拖到另一条上 ----------
  const alt = useRef(false);
  const drag = useRef<{ id: string; x0: number; y0: number; pinned: SimNode[]; hit: SimNode | null } | null>(null);
  const [linking, setLinking] = useState<{ x: number; y: number; from: SimNode; to: SimNode; choices: LinkChoice[] | null } | null>(null);
  const canLink = f.view === "records" && !replay;
  /** 光标附近最近的另一条记录；容差按屏幕 10px 算，缩放后手感一致。 */
  const linkTarget = (n: SimNode) => {
    const tol = 10 / (fg.current?.zoom() ?? 1);
    let best: SimNode | null = null, bestD = Infinity;
    for (const o of graph.nodes) {
      if (o.kind !== "record" || o.id === n.id || o.dying != null) continue;
      const dist = Math.hypot((o.x ?? 0) - n.x!, (o.y ?? 0) - n.y!);
      if (dist <= radius(o) + tol && dist < bestD) (best = o), (bestD = dist);
    }
    return best;
  };
  const onNodeDrag = (n: SimNode) => {
    if (drag.current?.id === n.id) return void (drag.current.hit = linkTarget(n));
    if (!canLink || n.kind !== "record" || n.dying != null || drag.current || !alt.current) return;
    // force-graph 在拖动开始时把节点原位置记在 __initialDragPos 上
    const start = (n as SimNode & { __initialDragPos?: { x: number; y: number } }).__initialDragPos;
    if (!start) return;
    // 拖线期间固定其他节点，目标不会被布局推走
    const pinned = graph.nodes.filter((o) => o.id !== n.id && o.fx == null);
    for (const o of pinned) (o.fx = o.x), (o.fy = o.y);
    drag.current = { id: n.id, x0: start.x, y0: start.y, pinned, hit: null };
  };
  const onNodeDragEnd = (n: SimNode) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== n.id) return;
    const hit = linkTarget(n);
    for (const o of d.pinned) (o.fx = undefined), (o.fy = undefined);
    // 拖动只用来连线，松手后节点回到原位
    Object.assign(n, { x: d.x0, y: d.y0, vx: 0, vy: 0 });
    if (!hit) return;
    const p = fg.current!.graph2ScreenCoords(hit.x!, hit.y!);
    // 菜单宽 260、最多两三行，靠近画布右下角时往里收
    setLinking({ x: Math.min(p.x, size.w - 290), y: Math.min(p.y, size.h - 140), from: n, to: hit, choices: null });
    linkChoices(n, hit).then((choices) => {
      if (!choices.length) {
        setLinking(null);
        toast("info", `「${tableLabel(byName[n.table!], n.table!)}」和「${tableLabel(byName[hit.table!], hit.table!)}」之间没有 link 字段`, "先用 dt-schema 给其中一张表加一个指向另一张表的 link 字段");
      } else setLinking((l) => l && l.from === n && l.to === hit ? { ...l, choices } : l);
    }, (e) => (setLinking(null), toastError(e)));
  };
  /** 两条记录之间能建的 link：a 的字段指向 b 的表，或者反过来。读一次记录拿到当前值和版本。 */
  const linkChoices = async (a: SimNode, b: SimNode) => {
    const out: LinkChoice[] = [];
    for (const [h, o] of [[a, b], [b, a]] as const) {
      const t = byName[h.table!];
      const fields = t?.fields.filter((x) => x.type === "link" && x.config?.table === o.table) ?? [];
      if (!fields.length) continue;
      const rec = await api.get(h.table!, h.rid!);
      for (const fd of fields) {
        const cur = asList<number>(rec[fd.key]);
        const multiple = !!fd.config?.multiple;
        out.push({
          key: `${h.id}.${fd.key}`,
          holder: { table: h.table!, id: h.rid!, version: rec._version },
          field: fd.key,
          target: o.rid!,
          multiple,
          label: `「${h.title}」的${fieldLabel(fd)} → 「${o.title}」`,
          exists: cur.includes(o.rid!),
          replaces: !multiple && cur.length && cur[0] !== o.rid ? cur[0] : null,
        });
      }
    }
    return out;
  };
  const chooseLink = (c: LinkChoice) => {
    setLinking(null);
    api.get(c.holder.table, c.holder.id).then((rec) => {
      const cur = asList<number>(rec[c.field]);
      const value = c.multiple ? [...cur.filter((x) => x !== c.target), c.target] : c.target;
      return api.update(c.holder.table, c.holder.id, { [c.field]: value }, c.holder.version);
    }).catch(toastError);
  };
  useEffect(() => setLinking(null), [shapeKey, replay?.snap]);

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
  const m = model.current;
  const records = graph.nodes.filter((n) => n.kind === "record").length;
  const orphans = Object.values(tableData?.orphans ?? {}).reduce((s, n) => s + n, 0);
  const stats = f.view === "tables"
    ? <>
        {tables.length} 张表 · {tables.reduce((s, t) => s + t.record_count, 0)} 条记录
        {orphans > 0 && <span> · {orphans} 条孤立记录（没有任何关联）</span>} · 点一张表查看它的记录
      </>
    : <>
        {records} 条记录 · {graph.links.length} 条连线
        {m?.truncated && !focusing && <span className="text-warn"> · 记录太多，只加载了最近更新的 {LIMIT} 条，先选表或设焦点</span>}
        {m?.truncated && focusing && <span className="text-warn"> · 关联记录超过 {LIMIT} 条，只显示了离焦点最近的</span>}
        {missingFocus && <span className="text-warn"> · 焦点记录不存在</span>}
        {replay && f.focus != null && <span className="text-warn"> · 回放时焦点不生效</span>}
        {replay ? <span> · 回放中，图是所选时刻的数据，不可编辑</span>
          : <span> · 单击查看数据，双击设为焦点，选中后 Shift+单击另一条查路径，按住 Alt 拖到另一条上建立关联</span>}
      </>;

  const tablesView = f.view === "tables";
  const linkLabel = (l: SimLink) => {
    const n = tablesView ? ` · ${l.count} 条` : "";
    if (l.kind === "actor") return esc(`${actorName(endId(l.source).slice(2))} 写入 ${l.count} 次`);
    if (l.kind === "parent") return esc(`父子${n}`);
    if (l.kind === "match") return esc(`同值 ${l.match}${tablesView ? "" : ` = ${l.value}`}${n}`);
    const t = byName[l.owner!];
    const fd = t?.fields.find((x) => x.key === l.field);
    return esc(`${tableLabel(t, l.owner!)}.${fd ? fieldLabel(fd) : l.field}${n}`);
  };
  const nodeLabel = (n: SimNode) => {
    if (n.kind === "actor") return esc(`操作者 ${actorName(n.title)} · 点击按它筛选`);
    if (n.kind === "table") {
      const lone = tableData?.orphans?.[n.table!];
      return esc(`${n.title} · ${n.count} 条记录${lone ? ` · ${lone} 条孤立` : ""}`);
    }
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
        linkFields={edgeKinds}
        colorOf={colorOf}
        focusTitle={f.focus != null ? m?.nodes.get(`r:${f.focus}`)?.title ?? null : null}
        focusCount={focusing && related ? related.length - 1 : null}
        search={search}
        onReheat={() => ((fit.current = true), fg.current?.d3ReheatSimulation())}
        replaying={!!replay}
        onReplay={startReplay}
        hubs={!replay && <HubsMenu tables={scope?.join(",")} kinds={kinds} colorOf={colorOf} onPick={(h) => setF({ focus: h.id })} />}
      />
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden border-t border-line bg-surface"
        onPointerDownCapture={(e) => void (alt.current = e.altKey)}>
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
            linkLineDash={(l) => (l.kind === "link" ? [3, 2] : l.kind === "match" ? [1, 2] : null)}
            linkCurvature="curvature"
            linkLabel={linkLabel}
            linkDirectionalArrowLength={(l) => (l.kind === "link" ? (tablesView ? 6 : 3.5) : 0)}
            linkDirectionalArrowRelPos={1}
            autoPauseRedraw={!anim}
            cooldownTime={8000}
            onNodeClick={onNodeClick}
            onNodeDrag={onNodeDrag}
            onNodeDragEnd={onNodeDragEnd}
            onRenderFramePost={(ctx, scale) => drawDragLine(ctx, scale, drag.current, model.current, palette)}
            onBackgroundClick={() => (setSelected(null), setLinking(null))}
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
        {path?.found && <PathBar path={path} onPick={pick} onClose={() => setPath(null)} />}
        {focusing && related && <RelatedList key={f.focus} items={related} colorOf={colorOf} selected={selected} onPick={pick} />}
        {!tablesView && <ActivityBand items={activity} onPick={locate} lift={!!replay} />}
        {replay && <ReplayBar replay={replay} onSeek={seek} onPlay={play} onClose={stopReplay} />}
        {linking && (
          <LinkMenu x={linking.x} y={linking.y} from={linking.from.title} to={linking.to.title} choices={linking.choices}
            onChoose={chooseLink} onClose={() => setLinking(null)} />
        )}
      </div>
    </>
  );
}
