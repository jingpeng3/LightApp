import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { Change, TableInfo } from "../api";
import { api } from "../api";
import { useChanges, useLiveStatus } from "../live";
import { actorColor, actorName, brief, clock, cx, diffKeys, fieldLabel, recTitle, relTime, tableLabel } from "../util";
import { useApp } from "./ui";

const MAX = 200;
const VERB: Record<Change["op"], string> = {
  insert: "新建", update: "修改", delete: "删除", create_table: "建表", alter_table: "改表结构", drop_table: "删表",
  create_domain: "新建域", alter_domain: "修改域", drop_domain: "删除域",
};

/** 右侧实时动态流。暂停时新事件先攒着，恢复后一次放出来。 */
export function Feed() {
  const [items, setItems] = useState<Change[]>([]);
  const [held, setHeld] = useState<Change[]>([]);
  const [paused, setPaused] = useState(false);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [, tick] = useState(0);
  const status = useLiveStatus();

  useEffect(() => {
    api.changes({ limit: 60 }).then((cs) => setItems(cs.reverse()), () => {});
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(timer);
  }, []);

  useChanges((c) => {
    if (paused) return setHeld((h) => [c, ...h]);
    setItems((xs) => [c, ...xs].slice(0, MAX));
    setFresh((s) => new Set(s).add(c.seq));
  });

  const resume = () => {
    setItems((xs) => [...held, ...xs].slice(0, MAX));
    setHeld([]);
    setPaused(false);
  };

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-line px-4">
        <span className={cx("size-[7px] rounded-full", status === "live" ? "live-dot bg-ok" : status === "connecting" ? "bg-warn" : "bg-danger")} />
        <h2 className="font-display text-[20px] leading-none">动态</h2>
        <span className="font-mono text-[10.5px] text-ink-3">{status === "live" ? "LIVE" : status === "connecting" ? "连接中" : "已断开，重连中"}</span>
        <button
          type="button"
          onClick={() => (paused ? resume() : setPaused(true))}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-ink-2 hover:bg-raise hover:text-ink"
          title={paused ? "继续" : "暂停滚动"}
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused && held.length > 0 && <span className="rounded bg-accent px-1 font-mono text-[10px] text-white">{held.length}</span>}
        </button>
      </header>
      <ol className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {items.map((c) => <FeedItem key={c.seq} change={c} fresh={fresh.has(c.seq)} />)}
        {!items.length && (
          <li className="px-3 py-10 text-center text-[12.5px] leading-relaxed text-ink-3">
            还没有动态。<br />agent 每次通过 dt 修改数据，都会出现在这里。
          </li>
        )}
      </ol>
    </aside>
  );
}

function FeedItem({ change: c, fresh }: { change: Change; fresh: boolean }) {
  const { byName, openRecord, select } = useApp();
  const table: TableInfo | undefined = byName[c.table_name];
  const color = actorColor(c.actor);
  const rec = c.after ?? c.before;
  const keys = c.op === "update" ? diffKeys(c.before, c.after) : [];
  const clickable = c.record_id != null && c.op !== "delete" && !!table;

  return (
    <li className={cx("group relative mb-0.5", fresh && "feed-in")}>
      <button
        type="button"
        disabled={!clickable && !table}
        onClick={() => (clickable ? openRecord({ table: c.table_name, id: c.record_id! }) : table && select(c.table_name))}
        className="block w-full rounded-md px-3 py-2 text-left hover:bg-raise disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="absolute top-2.5 bottom-2.5 left-0 w-[2px] rounded-full" style={{ background: color }} />
        <div className="flex items-baseline gap-1.5 text-[12px]">
          <span className="font-mono font-medium" style={{ color }}>{actorName(c.actor)}</span>
          <span className={cx("text-ink-2", c.op === "delete" && "text-danger")}>{VERB[c.op]}</span>
          <span className="truncate text-ink-2">{c.op.endsWith("_domain") ? (c.after ?? c.before)?.name as string : tableLabel(table, c.table_name)}</span>
          {c.record_id != null && <span className="font-mono text-[11px] text-ink-3">#{c.record_id}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3" title={clock(c.ts)}>{relTime(c.ts)}</span>
        </div>
        {(c.op === "insert" || c.op === "delete") && rec && c.record_id != null && (
          <div className={cx("mt-0.5 truncate text-[12.5px]", c.op === "delete" && "text-ink-3 line-through")}>{recTitle(table, rec)}</div>
        )}
        {keys.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {keys.slice(0, 4).map((k) => {
              const f = table?.fields.find((x) => x.key === k);
              return (
                <div key={k} className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                  <span className="shrink-0 text-ink-3">{f ? fieldLabel(f) : k}</span>
                  <span className="max-w-[90px] shrink truncate text-ink-3 line-through decoration-ink-3/40">{brief(f, c.before?.[k])}</span>
                  <span className="shrink-0 text-ink-3">→</span>
                  <span className="min-w-0 truncate font-medium">{brief(f, c.after?.[k])}</span>
                </div>
              );
            })}
            {keys.length > 4 && <div className="text-[11px] text-ink-3">另外 {keys.length - 4} 个字段</div>}
          </div>
        )}
      </button>
    </li>
  );
}
