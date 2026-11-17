import { Layers, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Domain, FileState, SavedView, TableInfo } from "./api";
import { api, setDomain } from "./api";
import { PreviewModal } from "./components/attachments";
import { NewRecordDrawer, RecordDrawer } from "./components/drawer";
import { EventsView } from "./components/events";
import { Feed } from "./components/feed";
import { FilterBar } from "./components/filterBar";
import { FullScreenRecord } from "./components/fullscreen";
import { GraphView } from "./components/graph";
import { Grid } from "./components/grid";
import { InboxView } from "./components/inbox";
import { SearchPalette } from "./components/searchPalette";
import { Sidebar } from "./components/sidebar";
import { Btn, Ctx, Empty, useApp, type AppCtx, type PreviewTarget, type Target } from "./components/ui";
import { compileWhere, EMPTY_QUERY, terms, type TableQuery } from "./filters";
import { onChange, startLive } from "./live";
import { tableQueryHash, useTableQuery } from "./useTableQuery";
import { cx, recordHash, tableHash, tableLabel, toastError, useAsk, useToasts } from "./util";

/** 地址栏 hash 是 #域/表；多一段数字就是记录的 _id，表的查询和图谱的筛选条件跟在 ? 后面。 */
function fromHash() {
  const [path, qs = ""] = location.hash.slice(1).split("?");
  const [d, t, id] = decodeURIComponent(path).split("/");
  return { domain: d || null, table: t || null, recordId: id && /^\d+$/.test(id) ? Number(id) : null, qs };
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
  return <DomainView key={domain.name} domain={domain} domains={domains} tableName={route.table} recordId={route.recordId} qs={route.qs} onSwitch={switchDomain} onDomainsChanged={loadDomains} />;
}

function DomainView({ domain, domains, tableName, recordId, qs, onSwitch, onDomainsChanged }: {
  domain: Domain;
  domains: Domain[];
  tableName: string | null;
  recordId: number | null;
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
  const [creating, setCreating] = useState<{ table: string; parentId?: number | null } | null>(null);
  const [preview, setPreview] = useState<{ target: PreviewTarget; state?: FileState } | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [palette, setPalette] = useState(false);
  const [feedOpen, toggleFeed] = usePanel("dt-feed", 1280);
  const [sidebarOpen, toggleSidebar] = usePanel("dt-sidebar", 1024);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "light");

  const loadTables = useCallback(() => api.tables().then(setTables, toastError), []);
  const loadViews = useCallback(() => api.views().then(setViews, toastError), []);

  useEffect(() => {
    loadTables();
    loadViews();
    // 表结构变化时重新拉表定义和视图；记录增删时只更新计数
    return onChange((c) => {
      if (c.op.endsWith("_view")) loadViews();
      else if (c.op === "create_table" || c.op === "alter_table" || c.op === "drop_table") (loadTables(), loadViews(), onDomainsChanged());
      else if (c.op === "insert" || c.op === "delete") {
        setTables((ts) => ts?.map((t) => (t.name === c.table_name ? { ...t, record_count: t.record_count + (c.op === "insert" ? 1 : -1) } : t)) ?? ts);
      }
    });
  }, [loadTables, loadViews, onDomainsChanged]);

  // ⌘K / Ctrl+K 打开全域搜索
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") (e.preventDefault(), setPalette((p) => !p));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const byName = useMemo(() => Object.fromEntries((tables ?? []).map((t) => [t.name, t])), [tables]);
  const table = (current && byName[current]) || (tables ?? []).find((t) => t.parent === null) || tables?.[0];

  const select = useCallback((name: string) => {
    location.hash = tableHash(domain.name, name);
  }, [domain.name]);

  // 只有正在看表格时，查询状态才和地址栏同步
  const onTable = !!table && !graphView && !inboxView && !eventsView && recordId == null;
  const [query, setQuery] = useTableQuery(domain.name, table?.name ?? null, onTable ? qs : "", onTable);
  const openView = useCallback((t: string, view: string) => {
    location.hash = tableQueryHash(domain.name, t, { ...EMPTY_QUERY, view });
  }, [domain.name]);

  // 全屏记录由地址栏驱动：链接用 #域/表/_id，打开新标签页就能直接看这条记录
  const full: Target | null = recordId != null && tableName ? { table: tableName, id: recordId } : null;
  const openFull = useCallback((t: Target) => {
    setCreating(null);
    setRecord(null);
    location.hash = recordHash(domain.name, t.table, t.id);
  }, [domain.name]);

  const ctx = useMemo<AppCtx>(() => ({
    domain: domain.name,
    tables: tables ?? [],
    byName,
    select,
    openRecord: (t) => (setCreating(null), setRecord(t)),
    openFull,
    openNew: (t, parentId) => (setRecord(null), setCreating({ table: t, parentId })),
    preview: (target) => {
      setPreview({ target });
      api.fileStatus([target.recordId]).then((s) => setPreview((p) => (p?.target === target ? { target, state: s[target.recordId]?.[target.field]?.[target.idx] } : p)), () => {});
    },
    views,
    reloadViews: loadViews,
    openView,
    currentView: onTable ? query.view : null,
  }), [domain.name, tables, byName, select, openFull, views, loadViews, openView, onTable, query.view]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("dt-theme", next);
    setTheme(next);
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-full">
        <Sidebar
          domain={domain} domains={domains} onSwitch={onSwitch}
          current={graphView ? "@graph" : inboxView ? "@inbox" : eventsView ? "@events" : table?.name ?? null}
          theme={theme} onTheme={toggleTheme}
          collapsed={!sidebarOpen} onCollapse={toggleSidebar}
          feedOpen={feedOpen} onToggleFeed={toggleFeed}
          onSearch={() => setPalette(true)}
        />
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
            <TableView key={table.name} table={table} query={query} setQuery={setQuery} views={views} onSaved={loadViews} />
          )}
        </main>
        {feedOpen && <Feed />}
      </div>
      {record && <RecordDrawer target={record} onClose={() => setRecord(null)} />}
      {full && <FullScreenRecord key={`${full.table}:${full.id}`} target={full} onClose={() => (location.hash = tableHash(domain.name, full.table))} />}
      {creating && <NewRecordDrawer key={creating.table} tableName={creating.table} parentId={creating.parentId} onClose={() => setCreating(null)} />}
      {preview && <PreviewModal key={`${preview.target.recordId}:${preview.target.field}:${preview.target.idx}`} target={preview.target} state={preview.state} onClose={() => setPreview(null)} />}
      {palette && <SearchPalette onClose={() => setPalette(false)} />}
      <AskDialog />
      <Toasts />
    </Ctx.Provider>
  );
}

/** 面板开关：记住用户的选择；窗口窄于 minWidth 时自动收起，变宽后恢复用户的选择。 */
function usePanel(key: string, minWidth: number) {
  const mq = useMemo(() => window.matchMedia(`(min-width: ${minWidth}px)`), [minWidth]);
  const saved = useCallback(() => localStorage.getItem(key) !== "0", [key]);
  const [open, setOpen] = useState(() => mq.matches && saved());
  useEffect(() => {
    const onChange = () => setOpen(mq.matches && saved());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mq, saved]);
  const toggle = useCallback(() => setOpen((o) => (localStorage.setItem(key, o ? "0" : "1"), !o)), [key]);
  return [open, toggle] as const;
}

type SetQuery = (q: Partial<TableQuery> | ((q: TableQuery) => TableQuery)) => void;

/** 一张表的页面：表头、筛选栏、表格。 */
function TableView({ table, query, setQuery, views, onSaved }: {
  table: TableInfo;
  query: TableQuery;
  setQuery: SetQuery;
  views: SavedView[];
  onSaved: () => void;
}) {
  const { byName } = useApp();
  const view = query.view ? views.find((v) => v.table === table.name && v.name === query.view) : undefined;
  const where = useMemo(() => compileWhere(table, byName, query), [table, byName, query]);
  const filter = useMemo(() => ({
    where,
    // 视图被删了以后还按名字发给服务端会报错，这时只用页面上的条件
    view: view ? view.name : null,
    terms: terms(query.q),
    sort: query.sort ?? view?.sort ?? null,
    onSort: (sort: string | null) => setQuery({ sort }),
    deep: query.deep,
  }), [where, view, query.q, query.sort, query.deep, setQuery]);
  return (
    <>
      <TableHeader table={table} query={query} setQuery={setQuery} />
      <FilterBar table={table} query={query} setQuery={setQuery} views={views} onSaved={onSaved} />
      <div className="flex min-h-0 flex-1 flex-col border-t border-line bg-surface">
        <Grid table={table} filter={filter} />
      </div>
    </>
  );
}

function TableHeader({ table, query, setQuery }: { table: TableInfo; query: TableQuery; setQuery: SetQuery }) {
  const { byName, select, openNew } = useApp();
  const ancestors: TableInfo[] = [];
  for (let t = table.parent ? byName[table.parent] : undefined; t; t = t.parent ? byName[t.parent] : undefined) ancestors.unshift(t);
  const desc = table.description ?? `${table.fields.length} 个字段${table.children.length ? ` · 子表 ${table.children.map((c) => tableLabel(byName[c], c)).join("、")}` : ""}`;
  // 输入框每敲一个字都会变，停顿 250ms 再写进查询；pushed 是最后一次写进去的值，用来分辨外部的修改（清除、切换视图）
  const [draft, setDraft] = useState(query.q);
  const pushed = useRef(query.q);
  useEffect(() => {
    if (query.q !== pushed.current) (pushed.current = query.q, setDraft(query.q));
  }, [query.q]);
  useEffect(() => {
    if (draft === pushed.current) return;
    const t = setTimeout(() => ((pushed.current = draft), setQuery({ q: draft })), 250);
    return () => clearTimeout(t);
  }, [draft, setQuery]);
  const kids = table.children.filter((c) => byName[c]);
  return (
    <header className="rise flex items-center gap-3 px-6 py-3">
      <div className="flex min-w-0 shrink items-baseline gap-1.5">
        {ancestors.map((t) => (
          <span key={t.name} className="flex shrink-0 items-baseline gap-1.5 font-mono text-[11px] text-ink-3">
            <button type="button" onClick={() => select(t.name)} className="hover:text-accent">{tableLabel(t, t.name)}</button>
            <span>/</span>
          </span>
        ))}
        <h1 className="truncate font-display text-[28px] leading-none">{tableLabel(table, table.name)}</h1>
      </div>
      {table.label && table.label !== table.name && <span className="shrink-0 font-mono text-[11px] text-ink-3">{table.name}</span>}
      <span className="shrink-0 rounded-[3px] border border-line-strong px-1 font-mono text-[10px] text-ink-3">v{table.schema_version}</span>
      {table.parent && <span className="shrink-0 rounded-[3px] border border-line-strong px-1 font-mono text-[10px] text-ink-3">{table.relation === "one_to_one" ? "一对一" : "一对多"} · {table.on_delete === "restrict" ? "限制删除" : "级联删除"}</span>}
      <p className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3" title={desc}>{desc}</p>
      <div className="flex shrink-0 items-center gap-2">
        <label className="flex h-8 w-[260px] items-center gap-1.5 rounded-md border border-line-strong bg-surface pr-1 pl-2.5 focus-within:border-accent">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft("")}
            placeholder="搜索，多个词用空格隔开"
            title="在文本、选项、标签、数字、附件路径里找；#12 按 _id 找"
            style={{ outline: "none" }} // 外框已经用 focus-within 标出焦点
            className="w-full min-w-0 bg-transparent placeholder:text-ink-3"
          />
          {draft && (
            <button type="button" title="清空搜索" onClick={() => setDraft("")} className="flex size-5 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink">
              <X size={12} />
            </button>
          )}
          {kids.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery({ deep: !query.deep })}
              title={query.deep ? "搜索范围：本表和子表（子表里命中的记录，所在行也算命中）" : `搜索范围：只搜本表。点一下把子表（${kids.map((c) => tableLabel(byName[c], c)).join("、")}）也算上`}
              className={cx("flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]", query.deep ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-raise hover:text-ink")}
            >
              <Layers size={12} /> 含子表
            </button>
          )}
        </label>
        {!table.parent && (
          <Btn kind="solid" onClick={() => openNew(table.name)} className="h-8 px-3"><Plus size={14} /> 新建记录</Btn>
        )}
      </div>
    </header>
  );
}

/** ask() 发起的确认框。Enter 确认，Esc 或点背景取消。 */
function AskDialog() {
  const q = useAsk();
  useEffect(() => {
    if (!q) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), q.resolve(false));
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [q]);
  if (!q) return null;
  return (
    <div className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_oklab,var(--ink)_24%,transparent)]" onMouseDown={() => q.resolve(false)}>
      <div role="alertdialog" aria-modal="true" className="rise w-[min(440px,calc(100vw-32px))] rounded-lg border border-line-strong bg-surface p-5 shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-[14px] font-medium break-words">{q.title}</h2>
        {q.body && <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{q.body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Btn kind="ghost" onClick={() => q.resolve(false)}>取消</Btn>
          <button
            type="button"
            autoFocus
            onClick={() => q.resolve(true)}
            className="inline-flex h-7 items-center rounded-md bg-danger px-3 text-[12.5px] text-white hover:opacity-90"
          >
            {q.ok ?? "确定"}
          </button>
        </div>
      </div>
    </div>
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
