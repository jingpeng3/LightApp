import { useEffect, useState } from "react";
import type { TableInfo } from "../api";
import { api } from "../api";
import { searchWhere, terms } from "../filters";
import { cx, tableLabel } from "../util";
import { Grid } from "./grid";
import { useApp } from "./ui";

/** 某条父记录下的子表，按 Tab 切换，每个 Tab 是一个紧凑表格。full 时铺满剩余空间。
 *  search 给了时（含子表搜索）只显示命中的子记录，Tab 上标出命中数，默认停在第一个有命中的 Tab。 */
export function ChildTabs({ table, parentId, full, search }: { table: TableInfo; parentId: number; full?: boolean; search?: string }) {
  const { byName } = useApp();
  const children = table.children.map((n) => byName[n]).filter(Boolean);
  const [tab, setTab] = useState(children[0]?.name);
  const [all, setAll] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const filtering = !!search && !all;

  useEffect(() => {
    if (!search) return setCounts({});
    let live = true;
    Promise.all(children.map((c) =>
      api.query(c.name, { where: searchWhere(c, byName, search, true), parent_id: parentId, limit: 1 }).then((r) => [c.name, r.total] as const),
    )).then((rs) => {
      if (!live) return;
      setCounts(Object.fromEntries(rs));
      const first = rs.find(([, n]) => n > 0);
      if (first) setTab(first[0]);
    }, () => {});
    return () => void (live = false);
    // children 由 table.children 和 byName 决定
  }, [search, parentId, table.children.join(","), byName]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = children.find((c) => c.name === tab) ?? children[0];
  if (!current) return null;
  return (
    <div className={cx(full && "flex min-h-0 flex-1 flex-col")}>
      <div className={cx("flex items-center gap-0.5", full ? "border-b border-line bg-panel px-6 py-2" : "mb-1.5")}>
        {children.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => setTab(c.name)}
            className={cx(
              "relative h-7 rounded-md px-2.5 text-[12.5px]",
              c.name === current.name ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:text-ink",
            )}
          >
            {tableLabel(c, c.name)}
            <span className="ml-1.5 font-mono text-[10.5px] text-ink-3">{c.relation === "one_to_one" ? "1:1" : "1:n"}</span>
            {filtering && counts[c.name] > 0 && <span className="ml-1.5 rounded bg-accent-soft px-1 font-mono text-[10px] text-accent">{counts[c.name]}</span>}
          </button>
        ))}
        {search && (
          <button type="button" onClick={() => setAll(!all)} className="ml-auto h-6 rounded px-2 text-[11.5px] text-ink-3 hover:bg-raise hover:text-ink">
            {all ? "只看命中" : "显示全部子记录"}
          </button>
        )}
      </div>
      <div className={cx("overflow-hidden bg-surface", full ? "flex min-h-0 flex-1 flex-col" : "rounded-lg border border-line")}>
        <Grid
          key={`${current.name}:${parentId}`}
          table={current}
          parentId={parentId}
          compact={!full}
          filter={search ? { where: filtering ? searchWhere(current, byName, search, true) : null, terms: terms(search), deep: filtering } : undefined}
        />
      </div>
    </div>
  );
}
