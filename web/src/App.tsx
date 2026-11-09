import { PanelRightClose, PanelRightOpen, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Domain, FileState, TableInfo } from "./api";
import { api, setDomain } from "./api";
import { PreviewModal } from "./components/attachments";
import { NewRecordDrawer, RecordDrawer } from "./components/drawer";
import { EventsView } from "./components/events";
import { Feed } from "./components/feed";
import { FullScreenRecord } from "./components/fullscreen";
import { GraphView } from "./components/graph";
import { Grid } from "./components/grid";
import { InboxView } from "./components/inbox";
import { Sidebar } from "./components/sidebar";
import { Btn, Ctx, Empty, useApp, type AppCtx, type PreviewTarget, type Target } from "./components/ui";
import { onChange, startLive } from "./live";
import { cx, tableLabel, toastError, useToasts } from "./util";

/** 地址栏 hash 是 #域/表；图谱的筛选条件跟在 ? 后面。 */
function fromHash() {
  const [path, qs = ""] = location.hash.slice(1).split("?");
  const [d, t] = decodeURIComponent(path).split("/");
  return { domain: d || null, table: t || null, qs };
}

export default function App() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [route, setRoute] = useState(fromHash);

  const loadDomains = useCallback(() => api.domains().then(setDomains, toastError), []);
  useEffect(() => {
    loadDomains();
    const onHash = () => setRoute(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadDomains]);

  const domain = domains?.find((d) => d.name === route.domain) ?? domains?.[0] ?? null;
  const domainName = domain?.name;
  // 先切换 api 的域和 WebSocket 订阅，再渲染域里的内容
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!domainName) return;
    setDomain(domainName);
    const stop = startLive(domainName);
    setActive(domainName);
    return () => (stop(), setActive(null));
  }, [domainName]);

  // agent 建域、改域、删域时刷新域列表
  useEffect(() => onChange((c) => {
    if (c.op === "create_domain" || c.op === "alter_domain" || c.op === "drop_domain") loadDomains();
  }), [loadDomains]);

  const switchDomain = useCallback((name: string) => void (location.hash = encodeURIComponent(name)), []);

  if (domains === null) return <div className="p-8 text-ink-3">连接 dt 服务…</div>;
  if (!domain) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty title="还没有域">
          域是一组表的命名空间，比如一个项目一个域。让 agent 运行 <code className="font-mono text-ink-2">dt domain apply -f project.yaml</code>，它会立刻出现在这里。
        </Empty>
        <Toasts />
      </div>
    );
  }
  if (active !== domain.name) return null;
  return <DomainView key={domain.name} domain={domain} domains={domains} tableName={route.table} qs={route.qs} onSwitch={switchDomain} onDomainsChanged={loadDomains} />;
}

function DomainView({ domain, domains, tableName, qs, onSwitch, onDomainsChanged }: {
  domain: Domain;
  domains: Domain[];
  tableName: string | null;
  qs: string;
  onSwitch: (name: string) => void;
  onDomainsChanged: () => void;
}) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const current = tableName;
  const eventsView = current === "@events";
  const inboxView = current === "@inbox";
  const graphView = current === "@graph";
  const [record, setRecord] = useState<Target | null>(null);
  const [full, setFull] = useState<Target | null>(null);
  const [creating, setCreating] = useState<{ table: string; parentId?: number | null } | null>(null);
  const [preview, setPreview] = useState<{ target: PreviewTarget; state?: FileState } | null>(null);
  const [search, setSearch] = useState("");
  const [feedOpen, setFeedOpen] = useState(() => localStorage.getItem("dt-feed") !== "0");
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "light");

  const loadTables = useCallback(() => api.tables().then(setTables, toastError), []);

  useEffect(() => {
    loadTables();
    // 表结构变化时重新拉表定义；记录增删时只更新计数
    return onChange((c) => {
      if (c.op === "create_table" || c.op === "alter_table" || c.op === "drop_table") (loadTables(), onDomainsChanged());
      else if (c.op === "insert" || c.op === "delete") {
        setTables((ts) => ts?.map((t) => (t.name === c.table_name ? { ...t, record_count: t.record_count + (c.op === "insert" ? 1 : -1) } : t)) ?? ts);
      }
    });
  }, [loadTables, onDomainsChanged]);

  const byName = useMemo(() => Object.fromEntries((tables ?? []).map((t) => [t.name, t])), [tables]);
  const table = (current && byName[current]) || (tables ?? []).find((t) => t.parent === null) || tables?.[0];

  const select = useCallback((name: string) => {
    location.hash = `${encodeURIComponent(domain.name)}/${encodeURIComponent(name)}`;
    setSearch("");
  }, [domain.name]);

  const ctx = useMemo<AppCtx>(() => ({
    domain: domain.name,
    tables: tables ?? [],
    byName,
    select,
    openRecord: (t) => (setCreating(null), setRecord(t)),
    openFull: (t) => (setCreating(null), setRecord(null), setFull(t)),
    openNew: (t, parentId) => (setRecord(null), setCreating({ table: t, parentId })),
    preview: (target) => {
      setPreview({ target });
      api.fileStatus([target.recordId]).then((s) => setPreview((p) => (p?.target === target ? { target, state: s[target.recordId]?.[target.field]?.[target.idx] } : p)), () => {});
    },
  }), [domain.name, tables, byName, select]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("dt-theme", next);
    setTheme(next);
  };

  const toggleFeed = () => {
    localStorage.setItem("dt-feed", feedOpen ? "0" : "1");
    setFeedOpen(!feedOpen);
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-full">
        <Sidebar domain={domain} domains={domains} onSwitch={onSwitch} current={graphView ? "@graph" : inboxView ? "@inbox" : eventsView ? "@events" : table?.name ?? null} theme={theme} onTheme={toggleTheme} />
        <main className="flex min-w-0 flex-1 flex-col">
          {tables === null ? (
            <div className="p-8 text-ink-3">连接 dt 服务…</div>
          ) : graphView ? (
            <GraphView qs={qs} />
          ) : inboxView ? (
            <InboxView />
          ) : eventsView ? (
            <EventsView />
          ) : !table ? (
            <div className="flex flex-1 items-center justify-center">
              <Empty title="这里还空着">
                域 {domain.name} 里还没有表。让 agent 用 dt-schema skill 设计一张，它会立刻出现在左边。
              </Empty>
            </div>
          ) : (
            <>
              <TableHeader key={table.name} table={table} search={search} onSearch={setSearch} feedOpen={feedOpen} onToggleFeed={toggleFeed} />
              <div className="flex min-h-0 flex-1 flex-col border-t border-line bg-surface">
                <Grid key={table.name} table={table} search={search} />
              </div>
            </>
          )}
        </main>
        {feedOpen && <Feed />}
      </div>
      {record && <RecordDrawer target={record} onClose={() => setRecord(null)} />}
      {full && <FullScreenRecord key={`${full.table}:${full.id}`} target={full} onClose={() => setFull(null)} />}
      {creating && <NewRecordDrawer key={creating.table} tableName={creating.table} parentId={creating.parentId} onClose={() => setCreating(null)} />}
      {preview && <PreviewModal key={`${preview.target.recordId}:${preview.target.field}:${preview.target.idx}`} target={preview.target} state={preview.state} onClose={() => setPreview(null)} />}
      <Toasts />
    </Ctx.Provider>
  );
}

function TableHeader({ table, search, onSearch, feedOpen, onToggleFeed }: {
  table: TableInfo;
  search: string;
  onSearch: (s: string) => void;
  feedOpen: boolean;
  onToggleFeed: () => void;
}) {
  const { byName, select, openNew } = useApp();
  const crumbs: TableInfo[] = [];
  for (let t: TableInfo | undefined = table; t; t = t.parent ? byName[t.parent] : undefined) crumbs.unshift(t);
  return (
    <header className="rise px-6 pt-5 pb-3">
      <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
        {crumbs.map((t, i) => (
          <span key={t.name} className="flex items-center gap-1.5">
            {i > 0 && <span>/</span>}
            <button type="button" onClick={() => select(t.name)} className={cx("hover:text-accent", t === table && "text-ink-2")}>{t.name}</button>
          </span>
        ))}
        <span className="ml-2 rounded-[3px] border border-line-strong px-1 text-[10px]">v{table.schema_version}</span>
        {table.parent && <span className="rounded-[3px] border border-line-strong px-1 text-[10px]">{table.relation === "one_to_one" ? "一对一" : "一对多"} · {table.on_delete === "restrict" ? "限制删除" : "级联删除"}</span>}
      </div>
      <div className="mt-1 flex items-end gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[40px] leading-[1.05]">{tableLabel(table, table.name)}</h1>
          <p className="mt-1 text-[12.5px] text-ink-3">
            {table.description ?? `${table.fields.length} 个字段${table.children.length ? ` · 子表 ${table.children.map((c) => tableLabel(byName[c], c)).join("、")}` : ""}`}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <label className="flex h-8 w-[220px] items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 focus-within:border-accent">
            <Search size={13} className="text-ink-3" />
            <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="搜索文本字段或 _id" className="w-full bg-transparent outline-none placeholder:text-ink-3" />
          </label>
          {!table.parent && (
            <Btn kind="solid" onClick={() => openNew(table.name)} className="h-8 px-3"><Plus size={14} /> 新建记录</Btn>
          )}
          <Btn kind="line" onClick={onToggleFeed} title={feedOpen ? "收起动态" : "展开动态"} className="h-8">
            {feedOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </Btn>
        </div>
      </div>
    </header>
  );
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="rise pointer-events-auto max-w-[520px] rounded-lg border border-line-strong bg-ink px-4 py-2.5 text-surface shadow-[var(--shadow)]">
          <div className="flex items-center gap-2 text-[13px]">
            <span className={cx("size-[6px] shrink-0 rounded-full", t.kind === "error" ? "bg-danger" : "bg-ok")} />
            {t.message}
          </div>
          {t.hint && <div className="mt-0.5 pl-[14px] text-[12px] opacity-70">{t.hint}</div>}
        </div>
      ))}
    </div>
  );
}
