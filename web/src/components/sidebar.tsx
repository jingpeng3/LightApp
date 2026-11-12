import { Activity, Check, ChevronRight, ChevronsUpDown, Mail, Moon, Network, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Sun } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import type { Domain, TableInfo } from "../api";
import { cx, tableLabel } from "../util";
import { useUnread } from "./inbox";
import { Popover, useApp } from "./ui";

const ICON_BTN = "flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-raise hover:text-ink";

/** 左侧表树：顶层表下面缩进显示子表，层数不限。收起时只留图标和表名首字。 */
export function Sidebar({ domain, domains, onSwitch, current, theme, onTheme, collapsed, onCollapse, feedOpen, onToggleFeed }: {
  domain: Domain;
  domains: Domain[];
  onSwitch: (name: string) => void;
  current: string | null;
  theme: string;
  onTheme: () => void;
  collapsed: boolean;
  onCollapse: () => void;
  feedOpen: boolean;
  onToggleFeed: () => void;
}) {
  const { tables, byName, select } = useApp();
  const roots = tables.filter((t) => t.parent === null);
  const unread = useUnread(domain.name);
  const tools = (
    <>
      <button type="button" onClick={onToggleFeed} title={feedOpen ? "收起动态" : "展开动态"} className={ICON_BTN}>
        {feedOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
      </button>
      <button type="button" onClick={onTheme} title={theme === "dark" ? "切换到浅色" : "切换到深色"} className={ICON_BTN}>
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button type="button" onClick={onCollapse} title={collapsed ? "展开侧栏" : "收起侧栏"} className={ICON_BTN}>
        {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>
    </>
  );

  if (collapsed) {
    return (
      <nav className="flex h-full w-[52px] shrink-0 flex-col items-center border-r border-line bg-panel">
        <div className="flex h-12 w-full items-center justify-center border-b border-line">
          <span className="font-display text-[26px] leading-none italic">dt</span>
        </div>
        <DomainPicker domain={domain} domains={domains} onSwitch={onSwitch} collapsed />
        <div className="mt-3 flex flex-col gap-1">
          <NavItem icon={<Mail size={14} />} label="收件箱" active={current === "@inbox"} onClick={() => select("@inbox")} collapsed badge={unread} />
          <NavItem icon={<Activity size={14} />} label="事件" active={current === "@events"} onClick={() => select("@events")} collapsed />
          <NavItem icon={<Network size={14} />} label="图谱" active={current === "@graph"} onClick={() => select("@graph")} collapsed />
        </div>
        <div className="my-3 h-px w-6 bg-line" />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-auto pb-3">
          {flatten(roots, byName).map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => select(t.name)}
              title={`${tableLabel(t, t.name)} · ${t.record_count} 条`}
              className={cx(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-[12.5px]",
                t.parent && "size-7 text-[11px]",
                current === t.name ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink",
              )}
            >
              {tableLabel(t, t.name).slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex flex-col items-center gap-1 border-t border-line py-2">{tools}</div>
      </nav>
    );
  }

  return (
    <nav className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-12 items-center gap-2 border-b border-line px-4 pr-2">
        <span className="font-display text-[26px] leading-none italic">dt</span>
        <span className="mt-1 text-[11px] tracking-[0.18em] text-ink-3 uppercase">动态表格</span>
        <span className="ml-auto flex items-center">{tools}</span>
      </div>
      <DomainPicker domain={domain} domains={domains} onSwitch={onSwitch} />
      <div className="mx-2 mt-3 flex flex-col gap-1">
        <NavItem icon={<Mail size={13} />} label="收件箱" hint="inbox" active={current === "@inbox"} onClick={() => select("@inbox")} badge={unread} />
        <NavItem icon={<Activity size={13} />} label="事件" hint="event" active={current === "@events"} onClick={() => select("@events")} />
        <NavItem icon={<Network size={13} />} label="图谱" hint="graph" active={current === "@graph"} onClick={() => select("@graph")} />
      </div>
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

function NavItem({ icon, label, hint, active, onClick, badge = 0, collapsed }: {
  icon: ReactNode;
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  collapsed?: boolean;
}) {
  const tone = active ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line)]" : "text-ink-2 hover:bg-raise hover:text-ink";
  if (collapsed) {
    return (
      <button type="button" onClick={onClick} title={badge > 0 ? `${label} · ${badge} 条未读` : label} className={cx("relative flex size-8 items-center justify-center rounded-md", tone)}>
        {icon}
        {badge > 0 && <span className="absolute top-1 right-1 size-[7px] rounded-full bg-accent ring-2 ring-panel" />}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cx("flex h-8 items-center gap-2 rounded-md px-2 text-[13px]", tone)}>
      <span className="shrink-0 text-ink-3">{icon}</span>
      <span>{label}</span>
      {badge > 0 ? (
        <span className="ml-auto rounded bg-accent px-1 font-mono text-[10px] leading-[15px] text-white">{badge > 99 ? "99+" : badge}</span>
      ) : (
        <span className="ml-auto font-mono text-[10.5px] text-ink-3">{hint}</span>
      )}
    </button>
  );
}

/** 按表树的先序顺序摊平，收起的侧栏里逐个列出。 */
function flatten(roots: TableInfo[], byName: Record<string, TableInfo>): TableInfo[] {
  const walk = (t: TableInfo): TableInfo[] => [t, ...t.children.flatMap((c) => (byName[c] ? walk(byName[c]) : []))];
  return roots.flatMap(walk);
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
function DomainPicker({ domain, domains, onSwitch, collapsed }: { domain: Domain; domains: Domain[]; onSwitch: (name: string) => void; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const avatar = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-ink font-display text-[16px] text-surface italic">
      {(domain.label || domain.name).slice(0, 1).toUpperCase()}
    </span>
  );
  return (
    <div className={cx("border-b border-line py-2", collapsed ? "flex w-full justify-center" : "px-2")}>
      {!collapsed && <div className="px-2 pb-1 text-[10.5px] font-medium tracking-[0.16em] text-ink-3 uppercase">域 · {domains.length}</div>}
      {collapsed ? (
        <button ref={ref} type="button" onClick={() => setOpen(!open)} title={`${domain.label || domain.name} · 切换域`} className={cx("rounded-md p-1 hover:bg-raise", open && "bg-raise")}>
          {avatar}
        </button>
      ) : (
        <button
          ref={ref}
          type="button"
          onClick={() => setOpen(!open)}
          className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raise", open && "bg-raise")}
        >
          {avatar}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-ink">{domain.label || domain.name}</span>
            <span className="block truncate font-mono text-[10.5px] text-ink-3">{domain.name}</span>
          </span>
          <ChevronsUpDown size={13} className="shrink-0 text-ink-3" />
        </button>
      )}
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
