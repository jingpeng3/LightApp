import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Rec, SearchGroup, TableInfo } from "../api";
import { api } from "../api";
import { EMPTY_QUERY, terms } from "../filters";
import { tableQueryHash } from "../useTableQuery";
import { asList, cx, fieldLabel, relTime, tableLabel, toastError } from "../util";
import { Highlight, hits } from "./linkText";
import { useApp } from "./ui";

/** 标题里没出现搜索词时，找出是哪个字段命中的，显示命中的那一段。 */
function matchedIn(table: TableInfo | undefined, rec: Rec, ts: string[]) {
  for (const f of table?.fields ?? []) {
    const v = rec[f.key];
    const texts = f.type === "attachment" ? asList<{ path: string }>(v).map((a) => a.path) : asList<unknown>(v).filter((x): x is string => typeof x === "string");
    for (const text of texts) {
      const line = text.split("\n").find((l) => hits(l, ts));
      if (line) return { label: fieldLabel(f), text: line };
    }
  }
  return null;
}

/** ⌘K：在整个域（含子表）里搜索。↑↓ 选择，Enter 打开记录，⌘Enter 在表格里查看这张表的全部命中。 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { domain, byName, openRecord } = useApp();
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setGroups(null);
    let live = true;
    const t = setTimeout(() => api.search(q.trim(), 6).then((r) => live && (setGroups(r.groups), setActive(0)), toastError), 200);
    return () => ((live = false), clearTimeout(t));
  }, [q]);

  const flat = useMemo(() => (groups ?? []).flatMap((g) => g.items.map((it) => ({ table: g.table, ...it }))), [groups]);
  const ts = terms(q);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (i: number) => {
    const it = flat[i];
    if (!it) return;
    onClose();
    openRecord({ table: it.table, id: it.id });
  };
  const showAll = (table: string) => {
    onClose();
    location.hash = tableQueryHash(domain, table, { ...EMPTY_QUERY, q: q.trim() });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, flat.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && flat[active]) showAll(flat[active].table);
    else if (e.key === "Enter") open(active);
    else if (e.key === "Escape") (e.stopPropagation(), onClose());
  };

  let i = -1;
  return (
    <div className="fade-in fixed inset-0 z-40 flex items-start justify-center bg-[color-mix(in_oklab,var(--ink)_18%,transparent)] px-4 pt-[12vh]" onMouseDown={onClose}>
      <div className="flex max-h-[70vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <Search size={15} className="text-ink-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="在整个域里搜索记录，多个词用空格隔开"
            style={{ outline: "none" }}
            className="h-full flex-1 bg-transparent text-[14px] placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line-strong px-1 font-mono text-[10.5px] text-ink-3">Esc</kbd>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {groups?.map((g) => {
            const t = byName[g.table];
            const parent = t?.parent ? byName[t.parent] : undefined;
            return (
              <section key={g.table} className="px-2 py-1">
                <div className="flex h-7 items-center gap-1.5 px-2 text-[11px] text-ink-3">
                  <span className="font-medium tracking-wide text-ink-2">{tableLabel(t, g.table)}</span>
                  {parent && <span className="font-mono">· {tableLabel(parent, parent.name)} 的子表</span>}
                  <span className="font-mono">{g.total} 条</span>
                  {g.total > g.items.length && (
                    <button type="button" onClick={() => showAll(g.table)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-raise hover:text-accent">
                      在表格中查看全部
                    </button>
                  )}
                </div>
                {g.items.map((it) => {
                  const n = ++i;
                  const where = hits(it.title, ts) ? null : matchedIn(t, it.record, ts);
                  return (
                    <button
                      key={it.id}
                      type="button"
                      data-i={n}
                      onMouseEnter={() => setActive(n)}
                      onClick={() => open(n)}
                      className={cx("flex h-9 w-full items-center gap-2 rounded-md px-2 text-left", n === active && "bg-raise")}
                    >
                      <span className="w-10 shrink-0 font-mono text-[11px] text-ink-3">#{it.id}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight text={it.title} terms={ts} />
                        {where && (
                          <span className="ml-2 text-[12px] text-ink-3">
                            {where.label}：<Highlight text={where.text} terms={ts} />
                          </span>
                        )}
                      </span>
                      {it.parent_id != null && <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{t?.parent}#{it.parent_id}</span>}
                      <span className="w-16 shrink-0 text-right font-mono text-[10.5px] text-ink-3">{relTime(it.record._updated_at)}</span>
                      {n === active && <CornerDownLeft size={12} className="shrink-0 text-ink-3" />}
                    </button>
                  );
                })}
              </section>
            );
          })}
          {groups && !groups.length && <div className="px-4 py-10 text-center text-ink-3">没有找到「{q.trim()}」</div>}
          {!groups && (
            <div className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
              搜索所有表和子表里的文本、选项、标签、数字和附件路径；输入 #12 按 _id 找。
            </div>
          )}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-panel px-4 font-mono text-[10.5px] text-ink-3">
          <span>↑↓ 选择</span>
          <span>↵ 打开记录</span>
          <span>⌘↵ 在表格中查看</span>
        </div>
      </div>
    </div>
  );
}
