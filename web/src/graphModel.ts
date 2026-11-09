import type { Change, GraphData, TableInfo } from "./api";
import { asList, recTitle } from "./util";

/** 图上的节点：记录 r:<id>、操作者 a:<名字>、表 t:<表名>。x/y 由力导向布局写入。 */
export interface SimNode {
  id: string;
  kind: "record" | "actor" | "table";
  rid?: number;
  table?: string;
  title: string;
  parent_id?: number | null;
  created_by?: string | null;
  updated_by?: string | null;
  updated_at?: string;
  child?: boolean;
  count?: number;
  deg?: number;
  dying?: number;
  x?: number;
  y?: number;
}

/** 边。kind=link 时 field 是 link 字段，owner 是持有该字段的表；born / dying 用来做闪烁和淡出。 */
export interface SimLink {
  key: string;
  source: string | SimNode;
  target: string | SimNode;
  kind: "parent" | "link" | "actor";
  field?: string;
  owner?: string;
  count?: number;
  curvature?: number;
  born?: number;
  dying?: number;
}

export interface Model {
  seq: number;
  total: number;
  truncated: boolean;
  nodes: Map<string, SimNode>;
  edges: Map<string, SimLink>;
  /** 操作者 → (记录节点 id → insert/update 次数) */
  touches: Map<string, Map<string, number>>;
  actors: Map<string, SimNode>;
}

export interface Filters {
  view: "records" | "tables";
  tables: string[] | null;
  focus: number | null;
  depth: number;
  off: string[];
  actors: string[];
  since: "" | "1h" | "24h";
  color: "table" | "actor";
}

export const FADE_MS = 1200;
export const endId = (e: string | SimNode) => (typeof e === "string" ? e : e.id);
const rid = (id: number) => `r:${id}`;
const key = (kind: string, s: string, t: string, field = "") => `${kind}:${s}>${t}:${field}`;

/** 边在「连线」开关里的名字：parent、actor、link:<表>.<字段>。 */
export const edgeFilterKey = (l: SimLink) => (l.kind === "link" ? `link:${l.owner}.${l.field}` : l.kind);

export function fromData(data: GraphData): Model {
  const m: Model = { seq: data.seq, total: data.total, truncated: data.truncated, nodes: new Map(), edges: new Map(), touches: new Map(), actors: new Map() };
  const tableOf = new Map<number, string>();
  for (const n of data.nodes) {
    tableOf.set(n.id, n.table);
    m.nodes.set(rid(n.id), { ...n, id: rid(n.id), rid: n.id, kind: "record" });
  }
  for (const e of data.edges) {
    const s = rid(e.source), t = rid(e.target);
    m.edges.set(key(e.kind, s, t, e.field), { key: key(e.kind, s, t, e.field), source: s, target: t, kind: e.kind, field: e.field, owner: tableOf.get(e.source) });
  }
  for (const t of data.touches) touch(m, t.actor, rid(t.record_id), t.count);
  return m;
}

function touch(m: Model, actor: string | null, id: string, n = 1) {
  if (!actor) return;
  let map = m.touches.get(actor);
  if (!map) m.touches.set(actor, (map = new Map()));
  map.set(id, (map.get(id) ?? 0) + n);
}

/** 记录现在的 link 值应当对应哪些边。 */
function linkTargets(table: TableInfo | undefined, rec: Record<string, unknown>) {
  const out: { field: string; target: string }[] = [];
  for (const f of table?.fields ?? []) {
    if (f.type === "link") for (const v of asList<number>(rec[f.key])) out.push({ field: f.key, target: rid(v) });
  }
  return out;
}

export interface Effect {
  id: string;
  /** 节点或边的集合变了，需要重新生成 graphData */
  structural: boolean;
  fields: string[];
  dying: boolean;
}

/** 把一条记录变更应用到图上；不是记录变更、或 seq 不比快照新时返回 null。 */
export function applyChange(m: Model, c: Change, byName: Record<string, TableInfo>, now: number): Effect | null {
  if (c.record_id == null || c.seq <= m.seq || !["insert", "update", "delete"].includes(c.op)) return null;
  m.seq = c.seq;
  const id = rid(c.record_id);
  const table = byName[c.table_name];
  let node = m.nodes.get(id);
  const eff: Effect = { id, structural: false, fields: [], dying: false };

  if (c.op === "delete") {
    if (!node) return null;
    node.dying = now;
    for (const e of m.edges.values()) if (endId(e.source) === id || endId(e.target) === id) e.dying = now;
    eff.dying = true;
    return eff;
  }
  const rec = c.after!;
  if (c.op === "insert" || !node) {
    if (c.op === "update") return null; // 超出 limit 没有加载的记录
    const near = m.nodes.get(rid(rec._parent_id ?? -1)) ?? linkTargets(table, rec).map((x) => m.nodes.get(x.target)).find(Boolean);
    node = { id, kind: "record", rid: c.record_id, table: c.table_name, child: !!table?.parent, title: "", parent_id: rec._parent_id, created_by: c.actor };
    if (near?.x != null) (node.x = near.x + (Math.random() - 0.5) * 20), (node.y = near.y! + (Math.random() - 0.5) * 20);
    m.nodes.set(id, node);
    const p = rid(rec._parent_id ?? -1);
    if (m.nodes.has(p)) m.edges.set(key("parent", p, id), { key: key("parent", p, id), source: p, target: id, kind: "parent", born: now });
    eff.structural = true;
  } else {
    eff.fields = Object.keys(rec).filter((k) => !k.startsWith("_") && JSON.stringify(c.before?.[k]) !== JSON.stringify(rec[k]));
  }
  node.title = recTitle(table, rec);
  node.updated_by = c.actor;
  node.updated_at = c.ts;

  const want = new Map(linkTargets(table, rec).filter((x) => m.nodes.has(x.target)).map((x) => [key("link", id, x.target, x.field), x]));
  for (const e of m.edges.values()) {
    if (e.kind === "link" && endId(e.source) === id && !want.has(e.key) && !e.dying) (e.dying = now), (eff.dying = true);
  }
  for (const [k, x] of want) {
    const e = m.edges.get(k);
    if (e && !e.dying) continue;
    m.edges.set(k, { key: k, source: id, target: x.target, kind: "link", field: x.field, owner: c.table_name, born: now });
    eff.structural = true;
  }
  const before = m.touches.get(c.actor ?? "")?.has(id);
  touch(m, c.actor, id);
  if (!before && c.actor) eff.structural = true;
  return eff;
}

/** 删掉淡出结束的节点和边，返回是否有东西被删。 */
export function purge(m: Model, now: number) {
  let removed = false;
  for (const [id, n] of m.nodes) {
    if (n.dying != null && now - n.dying >= FADE_MS) {
      m.nodes.delete(id);
      for (const map of m.touches.values()) map.delete(id);
      removed = true;
    }
  }
  for (const [k, e] of m.edges) {
    if ((e.dying != null && now - e.dying >= FADE_MS) || !m.nodes.has(endId(e.source)) || !m.nodes.has(endId(e.target))) {
      m.edges.delete(k);
      removed = true;
    }
  }
  return removed;
}

const WINDOW: Record<string, number> = { "1h": 3600e3, "24h": 86400e3 };

/** 按筛选条件算出当前要画的节点和边；节点对象跨次复用，布局位置不会丢。 */
export function visible(m: Model, f: Filters) {
  const off = new Set(f.off);
  const since = f.since ? Date.now() - WINDOW[f.since] : 0;
  const wanted = f.actors.length ? f.actors.map((a) => m.touches.get(a) ?? new Map<string, number>()) : null;
  const nodes = new Map<string, SimNode>();
  for (const [id, n] of m.nodes) {
    if (since && (n.dying == null) && Date.parse(n.updated_at ?? "") < since) continue;
    if (wanted && !wanted.some((map) => map.has(id))) continue;
    nodes.set(id, n);
  }
  let links: SimLink[] = [];
  for (const e of m.edges.values()) {
    if (!off.has(edgeFilterKey(e)) && nodes.has(endId(e.source)) && nodes.has(endId(e.target))) links.push(e);
  }
  if (!off.has("actor")) {
    for (const [actor, map] of m.touches) {
      if (f.actors.length && !f.actors.includes(actor)) continue;
      const id = `a:${actor}`;
      let added = false;
      for (const [nid, count] of map) {
        if (!nodes.has(nid)) continue;
        links.push({ key: `actor:${id}>${nid}`, source: id, target: nid, kind: "actor", count });
        added = true;
      }
      if (!added) continue;
      let a = m.actors.get(actor);
      if (!a) m.actors.set(actor, (a = { id, kind: "actor", title: actor }));
      nodes.set(id, a);
    }
  }

  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of links) link(endId(e.source), endId(e.target)), link(endId(e.target), endId(e.source));

  let missingFocus = false;
  if (f.focus != null) {
    const start = rid(f.focus);
    const seen = new Set<string>();
    if (nodes.has(start)) {
      seen.add(start);
      let frontier = [start];
      for (let d = 0; d < f.depth && frontier.length; d++) {
        const next: string[] = [];
        for (const id of frontier) for (const n of adj.get(id) ?? []) if (!seen.has(n)) (seen.add(n), next.push(n));
        frontier = next;
      }
    } else missingFocus = true;
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    links = links.filter((e) => seen.has(endId(e.source)) && seen.has(endId(e.target)));
  }

  for (const n of nodes.values()) n.deg = 0;
  for (const e of links) (nodes.get(endId(e.source))!.deg! += 1), (nodes.get(endId(e.target))!.deg! += 1);
  curve(links);
  return { nodes: [...nodes.values()], links, missingFocus };
}

/** 同一对节点之间有多条边、或自己连自己时，给每条边不同的弧度，避免重叠。 */
export function curve(links: SimLink[]) {
  const groups = new Map<string, SimLink[]>();
  for (const e of links) {
    const [a, b] = [endId(e.source), endId(e.target)].sort();
    const k = `${a}|${b}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  for (const g of groups.values()) {
    g.forEach((e, i) => {
      if (endId(e.source) === endId(e.target)) e.curvature = 0.5 + i * 0.3;
      else e.curvature = g.length === 1 ? 0 : (i - (g.length - 1) / 2) * 0.35;
    });
  }
}

// ---------- 筛选条件和地址栏 ----------

export function readFilters(qs: string, totalRecords: number): Filters {
  const p = new URLSearchParams(qs);
  const list = (k: string) => (p.get(k) ?? "").split(",").filter(Boolean);
  const view = p.get("view");
  const since = p.get("since");
  return {
    view: view === "tables" || view === "records" ? view : totalRecords > 1500 ? "tables" : "records",
    tables: p.has("tables") && list("tables").length ? list("tables") : null,
    focus: p.has("focus") && /^\d+$/.test(p.get("focus")!) ? Number(p.get("focus")) : null,
    depth: Math.min(3, Math.max(1, Number(p.get("depth")) || 2)),
    off: p.has("off") ? list("off") : ["actor"],
    actors: list("actors"),
    since: since === "1h" || since === "24h" ? since : "",
    color: p.get("color") === "actor" ? "actor" : "table",
  };
}

export function writeFilters(f: Filters) {
  const p = new URLSearchParams();
  p.set("view", f.view);
  if (f.tables) p.set("tables", f.tables.join(","));
  if (f.focus != null) p.set("focus", String(f.focus));
  if (f.depth !== 2) p.set("depth", String(f.depth));
  if (f.off.join(",") !== "actor") p.set("off", f.off.join(","));
  if (f.actors.length) p.set("actors", f.actors.join(","));
  if (f.since) p.set("since", f.since);
  if (f.color !== "table") p.set("color", f.color);
  return p.toString().replace(/%2C/g, ",");
}
