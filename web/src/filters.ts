import type { Field, TableInfo } from "./api";

/** 筛选栏里的一个条件。多个条件之间是「同时满足」。 */
export interface Cond {
  key: string;
  op: "in" | "nin" | "contains" | "eq" | "range" | "date" | "empty" | "not_empty";
  value?: unknown;
}

/** 一张表当前的查询：命名视图 + 搜索词 + 筛选条件 + 排序。都会写进地址栏，刷新和分享链接后还在。 */
export interface TableQuery {
  view: string | null;
  q: string;
  deep: boolean; // 搜索时把子表（含多级）也算上
  filters: Cond[];
  sort: string | null;
}

export const EMPTY_QUERY: TableQuery = { view: null, q: "", deep: false, filters: [], sort: null };

type Where = Record<string, unknown>;

/** 筛选条件可以用的字段：表字段 + 系统字段。系统字段用一个假的 Field 描述，方便统一处理。 */
export const SYSTEM_FIELDS: Field[] = [
  { key: "_created_by", type: "person", label: "创建者" },
  { key: "_updated_by", type: "person", label: "最后修改者" },
  { key: "_created_at", type: "datetime", label: "创建时间" },
  { key: "_updated_at", type: "datetime", label: "最后更新" },
];

export function filterFields(table: TableInfo): Field[] {
  return [...table.fields, ...SYSTEM_FIELDS];
}

/** 系统字段里的 person 没有固定选项，取值从 facets 统计里来。 */
export const FACET_TYPES: Field["type"][] = ["single_select", "multi_select", "person", "checkbox"];

/** 日期快捷项，值用服务端认得的相对日期，存成视图后每天自动往前走。 */
export const DATE_PRESETS: { id: string; label: string; where: Where }[] = [
  { id: "today", label: "今天", where: { gte: "$today", lt: "$today+1d" } },
  { id: "past", label: "早于今天", where: { lt: "$today" } },
  { id: "week", label: "本周", where: { gte: "$week_start", lt: "$week_start+7d" } },
  { id: "next7", label: "未来 7 天", where: { gte: "$today", lt: "$today+7d" } },
  { id: "last7", label: "过去 7 天", where: { gte: "$today-6d", lt: "$today+1d" } },
  { id: "month", label: "本月以来", where: { gte: "$month_start" } },
];

const isTimestamp = (f: Field) => f.type === "datetime";
const nextDay = (d: string) => {
  const t = new Date(d + "T00:00:00");
  t.setDate(t.getDate() + 1);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
// datetime 按 UTC 存，自定义区间的本地日期先换成 UTC 时间再比较
const bound = (f: Field, d: string) => (isTimestamp(f) ? new Date(d + "T00:00:00").toISOString() : d);

export function condWhere(f: Field, c: Cond): Where | null {
  const v = c.value;
  switch (c.op) {
    case "empty":
      return { is_null: true };
    case "not_empty":
      return { is_null: false };
    case "in":
    case "nin":
      return Array.isArray(v) && v.length ? { [c.op]: v } : null;
    case "contains":
      return typeof v === "string" && v.trim() ? { contains: v.trim() } : null;
    case "eq":
      return v === undefined ? null : { eq: v };
    case "range": {
      const [a, b] = (v as [number | null, number | null]) ?? [];
      const w: Where = {};
      if (a != null) w.gte = a;
      if (b != null) w.lte = b;
      return Object.keys(w).length ? w : null;
    }
    case "date": {
      if (typeof v === "string") return DATE_PRESETS.find((p) => p.id === v)?.where ?? null;
      const [a, b] = (v as [string | null, string | null]) ?? [];
      const w: Where = {};
      if (a) w.gte = bound(f, a);
      if (b) w.lt = bound(f, nextDay(b));
      return Object.keys(w).length ? w : null;
    }
  }
}

/** 搜索词编成 $search；deep 时子表里命中的父记录也算，子表还有子表就继续往下。 */
export function searchWhere(table: TableInfo, byName: Record<string, TableInfo>, q: string, deep: boolean): Where | null {
  if (!q.trim()) return null;
  const own = { $search: q.trim() };
  if (!deep) return own;
  const kids = table.children.filter((c) => byName[c]).map((c) => ({ $child: { table: c, where: searchWhere(byName[c], byName, q, true) } }));
  return kids.length ? { $or: [own, ...kids] } : own;
}

/** 整个查询编成 where（视图自己的条件由服务端按 view 名字叠加）。表结构变了以后，不存在的字段直接跳过。 */
export function compileWhere(table: TableInfo, byName: Record<string, TableInfo>, query: TableQuery, skip?: number): Where | null {
  const fields = filterFields(table);
  const parts: Where[] = [];
  query.filters.forEach((c, i) => {
    const f = fields.find((x) => x.key === c.key);
    const w = f && i !== skip ? condWhere(f, c) : null;
    if (w) parts.push({ [c.key]: w });
  });
  const s = searchWhere(table, byName, query.q, query.deep);
  if (s) parts.push(s);
  return !parts.length ? null : parts.length === 1 ? parts[0] : { $and: parts };
}

export const isFiltering = (q: TableQuery) => !!(q.view || q.q.trim() || q.filters.length);

/** 搜索词拆成高亮用的词。 */
export const terms = (q: string) => q.trim().split(/\s+/).filter(Boolean);

// ---------- 地址栏 ----------

export function toQs(q: TableQuery): string {
  const p = new URLSearchParams();
  if (q.view) p.set("view", q.view);
  if (q.q) p.set("q", q.q);
  if (q.deep) p.set("deep", "1");
  if (q.filters.length) p.set("f", JSON.stringify(q.filters));
  if (q.sort) p.set("sort", q.sort);
  return p.toString();
}

export function fromQs(qs: string): TableQuery {
  const p = new URLSearchParams(qs);
  let filters: Cond[] = [];
  try {
    const f = JSON.parse(p.get("f") ?? "[]");
    if (Array.isArray(f)) filters = f.filter((c) => c && typeof c.key === "string" && typeof c.op === "string");
  } catch {
    // 链接被截断或手改坏了就当没有筛选
  }
  return { view: p.get("view"), q: p.get("q") ?? "", deep: p.get("deep") === "1", filters, sort: p.get("sort") };
}
