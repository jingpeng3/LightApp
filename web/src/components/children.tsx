import { useState } from "react";
import type { TableInfo } from "../api";
import { cx, tableLabel } from "../util";
import { Grid } from "./grid";
import { useApp } from "./ui";

/** 某条父记录下的子表，按 Tab 切换，每个 Tab 是一个紧凑表格。full 时铺满剩余空间。 */
export function ChildTabs({ table, parentId, full }: { table: TableInfo; parentId: number; full?: boolean }) {
  const { byName } = useApp();
  const children = table.children.map((n) => byName[n]).filter(Boolean);
  const [tab, setTab] = useState(children[0]?.name);
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
          </button>
        ))}
      </div>
      <div className={cx("overflow-hidden bg-surface", full ? "flex min-h-0 flex-1 flex-col" : "rounded-lg border border-line")}>
        <Grid key={`${current.name}:${parentId}`} table={current} parentId={parentId} compact={!full} />
      </div>
    </div>
  );
}
