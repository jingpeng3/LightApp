import { Activity, Check, ChevronRight, ChevronsUpDown, Mail, Moon, Network, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Domain, TableInfo } from "../api";
import { api } from "../api";
import { cx, tableLabel } from "../util";
import { Popover, useApp } from "./ui";

/** 左侧表树：顶层表下面缩进显示子表，层数不限。 */
export function Sidebar({ domain, domains, onSwitch, current, theme, onTheme }: {
  domain: Domain;
  domains: Domain[];
  onSwitch: (name: string) => void;
  current: string | null;
  theme: string;
  onTheme: () => void;
}) {
  const { tables, select } = useApp();
  const roots = tables.filter((t) => t.parent === null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => api.inbox({ status: "unread", limit: 1 }).then((data) => alive && setUnread(data.unread), () => {});
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [domain.name]);
  return (
    <nav className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        <span className="font-display text-[26px] leading-none italic">dt</span>
        <span className="mt-1 text-[11px] tracking-[0.18em] text-ink-3 uppercase">动态表格</span>
        <button
          type="button"
          onClick={onTheme}
          title={theme === "dark" ? "切换到浅色" : "切换到深色"}
          className="ml-auto flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-raise hover:text-ink"
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
      <DomainPicker domain={domain} domains={domains} onSwitch={onSwitch} />
      <button
        type="button"
        onClick={() => select("@inbox")}
        className={cx(
          "mx-2 mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-[13px]",
          current === "@inbox" ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink",
        )}
      >
        <Mail size={13} className="shrink-0 text-ink-3" />
        <span>收件箱</span>
        {unread > 0 ? (
          <span className="ml-auto rounded bg-accent px-1 font-mono text-[10px] leading-[15px] text-white">{unread > 99 ? "99+" : unread}</span>
        ) : (
          <span className="ml-auto font-mono text-[10.5px] text-ink-3">inbox</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => select("@events")}
        className={cx(
          "mx-2 mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-[13px]",
          current === "@events" ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink",
        )}
      >
        <Activity size={13} className="shrink-0 text-ink-3" />
        <span>事件</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-3">event</span>
      </button>
      <button
        type="button"
        onClick={() => select("@graph")}
        className={cx(
          "mx-2 mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-[13px]",
          current === "@graph" ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink",
        )}
      >
        <Network size={13} className="shrink-0 text-ink-3" />
        <span>图谱</span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-3">graph</span>
      </button>
      <div className="px-4 pt-3 pb-1.5 text-[10.5px] font-medium tracking-[0.16em] text-ink-3 uppercase">表 · {tables.length}</div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {roots.map((t, i) => (
          <div key={t.name} className="rise" style={{ animationDelay: `${i * 40}ms` }}>
            <TreeItem table={t} depth={0} current={current} />
          </div>
        ))}
        {!tables.length && (
          <p className="px-2 py-4 text-[12px] leading-relaxed text-ink-3">
            还没有表。让 agent 用 dt-schema skill 建一张，或者运行
            <code className="mt-1.5 block rounded bg-raise px-2 py-1 font-mono text-[11px] text-ink-2">dt table apply -D {domain.name} -f task.yaml</code>
          </p>
        )}
      </div>
    </nav>
  );
}

function TreeItem({ table, depth, current }: { table: TableInfo; depth: number; current: string | null }) {
  const { byName, select } = useApp();
  const kids = table.children.map((n) => byName[n]).filter(Boolean);
  const [open, setOpen] = useState(true);
  const active = current === table.name;
  return (
    <>
      <div
        className={cx("group relative flex h-8 items-center rounded-md pr-2 text-[13px]", active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink")}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {active && <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-accent" />}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cx("flex size-5 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink", !kids.length && "invisible")}
        >
          <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        </button>
        <button type="button" onClick={() => select(table.name)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {depth > 0 && <span className="font-mono text-[10px] text-ink-3">{table.relation === "one_to_one" ? "1:1" : "1:n"}</span>}
          <span className="truncate">{tableLabel(table, table.name)}</span>
          <span className="ml-auto font-mono text-[10.5px] text-ink-3">{table.record_count}</span>
        </button>
      </div>
      {open && kids.map((k) => <TreeItem key={k.name} table={k} depth={depth + 1} current={current} />)}
    </>
  );
}

/** 当前域，点开切换到其他域。 */
function DomainPicker({ domain, domains, onSwitch }: { domain: Domain; domains: Domain[]; onSwitch: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div className="border-b border-line px-2 py-2">
      <div className="px-2 pb-1 text-[10.5px] font-medium tracking-[0.16em] text-ink-3 uppercase">域 · {domains.length}</div>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen(!open)}
        className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raise", open && "bg-raise")}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-ink font-display text-[16px] text-surface italic">
          {(domain.label || domain.name).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{domain.label || domain.name}</span>
          <span className="block truncate font-mono text-[10.5px] text-ink-3">{domain.name}</span>
        </span>
        <ChevronsUpDown size={13} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} width={260}>
          <div className="p-1">
            {domains.map((d) => (
              <button
                key={d.name}
                type="button"
                onClick={() => (setOpen(false), onSwitch(d.name))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raise"
              >
                <span className="flex size-[14px] shrink-0 items-center justify-center">
                  {d.name === domain.name && <Check size={13} className="text-accent" strokeWidth={2.5} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{d.label || d.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-ink-3">{d.name}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-[10.5px] leading-tight text-ink-3">
                  {d.table_count} 表<br />{d.record_count} 条
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-ink-3">
            新建域：<code className="font-mono text-ink-2">dt domain apply -f &lt;域模版&gt;</code>
          </div>
        </Popover>
      )}
    </div>
  );
}
