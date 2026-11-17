import { useCallback, useEffect, useState } from "react";
import { EMPTY_QUERY, fromQs, toQs, type TableQuery } from "./filters";
import { tableHash } from "./util";

const storeKey = (domain: string, table: string) => `dt-query:${domain}/${table}`;

/** 地址栏带了查询就用地址栏的（打开分享的链接），否则用这张表上次留下的。 */
function read(domain: string, table: string | null, qs: string): TableQuery {
  if (!table) return EMPTY_QUERY;
  return fromQs(qs || (localStorage.getItem(storeKey(domain, table)) ?? ""));
}

/** 当前表的查询状态。每张表各自记在 localStorage 里，同时写进地址栏 #域/表?…，刷新和分享链接后还在。
 *  active 为 false 时（在看图谱、事件，或打开了全屏记录）不改地址栏。 */
export function useTableQuery(domain: string, table: string | null, qs: string, active: boolean) {
  // seen 是上次看到的地址栏查询串，用来区分「地址栏被外部改了」和「我们自己刚写进去」
  const [s, setS] = useState(() => ({ table, seen: qs, q: read(domain, table, qs) }));
  let cur = s;
  if (s.table !== table) {
    cur = { table, seen: qs, q: read(domain, table, qs) };
    setS(cur);
  } else if (qs !== s.seen) {
    // 点了侧栏的视图、⌘K 里的「在表中查看」，或者打开了别人分享的链接
    cur = { table, seen: qs, q: active && qs && qs !== toQs(s.q) ? fromQs(qs) : s.q };
    setS(cur);
  }
  const text = toQs(cur.q);

  useEffect(() => {
    if (!table) return;
    if (text) localStorage.setItem(storeKey(domain, table), text);
    else localStorage.removeItem(storeKey(domain, table));
    // 没有查询时不去动只写了 #域 的地址
    if (!active || (!text && !qs)) return;
    const want = tableHash(domain, table) + (text ? `?${text}` : "");
    if (location.hash === want) return;
    // 不新增历史记录；再发一次 hashchange，让路由里的 qs 跟上
    history.replaceState(null, "", want);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    // qs 也要算上：点侧栏的表名会把地址栏的查询去掉，这时要写回去
  }, [domain, table, text, active, qs]);

  const set = useCallback((patch: Partial<TableQuery> | ((q: TableQuery) => TableQuery)) =>
    setS((prev) => ({ ...prev, q: typeof patch === "function" ? patch(prev.q) : { ...prev.q, ...patch } })), []);
  return [cur.q, set] as const;
}

/** 从别处跳到某张表并带上一组查询（侧栏视图、⌘K）。 */
export function tableQueryHash(domain: string, table: string, q: TableQuery) {
  const text = toQs(q);
  return tableHash(domain, table) + (text ? `?${text}` : "");
}
