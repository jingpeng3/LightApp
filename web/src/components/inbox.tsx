import { CheckCheck, ChevronDown, ChevronRight, Code2, Inbox, MailOpen, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { InboxMessage, InboxPage, TableInfo } from "../api";
import { api } from "../api";
import { onChange } from "../live";
import { ask, brief, clock, cx, fieldLabel, relTime, tableLabel, toast, toastError } from "../util";
import { ActorChip, Btn, Empty, useApp } from "./ui";

const OP_LABEL = { insert: "新增", update: "变更", delete: "删除" } as const;

// 收件箱消息由服务端调度器在记录变更之后异步写入，WebSocket 不推送它们：
// 收到变更后等调度器处理完再拉；读状态可能被 CLI 改掉，另加慢速兜底轮询
const SETTLE_MS = 1500;
const FALLBACK_MS = 30000;

let unread = 0;
const unreadListeners = new Set<() => void>();
const setUnread = (n: number) => {
  unread = n;
  unreadListeners.forEach((fn) => fn());
};

/** 在变更推送后、窗口重新获得焦点时以及兜底定时器到点时调用 load。 */
function useInboxRefresh(load: () => void) {
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const off = onChange((c) => {
      if (c.op !== "insert" && c.op !== "update" && c.op !== "delete") return;
      clearTimeout(settle);
      settle = setTimeout(load, SETTLE_MS);
    });
    const timer = setInterval(load, FALLBACK_MS);
    window.addEventListener("focus", load);
    return () => {
      off();
      clearTimeout(settle);
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);
}

/** 当前域的未读消息数，侧栏和收件箱页共用。 */
export function useUnread(domain: string) {
  const load = useCallback(() => {
    api.inbox({ status: "unread", limit: 1 }).then((data) => setUnread(data.unread), () => {});
  }, []);
  useEffect(() => {
    setUnread(0);
    load();
  }, [domain, load]);
  useInboxRefresh(load);
  return useSyncExternalStore(
    (fn) => {
      unreadListeners.add(fn);
      return () => void unreadListeners.delete(fn);
    },
    () => unread,
  );
}

/** 收件箱：被 inbox 绑定收集的记录事件。 */
export function InboxView() {
  const { domain, byName, openRecord, select } = useApp();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [data, setData] = useState<InboxPage | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [raw, setRaw] = useState<number | null>(null);

  const load = useCallback((quiet = false) => {
    api.inbox({ status: filter === "unread" ? "unread" : undefined, limit: 100 }).then(
      (page) => (setData(page), setUnread(page.unread)),
      quiet ? () => {} : toastError,
    );
  }, [filter]);
  const quietLoad = useCallback(() => load(true), [load]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useInboxRefresh(quietLoad);

  const mark = (message: InboxMessage, read: boolean) => {
    api.markInbox(message.id, read ? "read" : "unread").then(() => load(true), toastError);
  };

  const readAll = () => {
    api.readAllInbox().then((result) => {
      toast("info", `已把 ${result.updated} 条消息标为已读`);
      load(true);
    }, toastError);
  };

  const remove = async (message: InboxMessage) => {
    if (!(await ask(`删除收件箱消息「${message.title}」？`, { ok: "删除" }))) return;
    api.deleteInbox(message.id).then(() => {
      setExpanded((id) => (id === message.id ? null : id));
      load(true);
    }, toastError);
  };

  const toggle = (message: InboxMessage) => {
    setExpanded((id) => (id === message.id ? null : message.id));
    if (message.status === "unread") mark(message, true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
          <span>{domain}</span>
          <span>/</span>
          <span className="text-ink-2">收件箱</span>
        </div>
        <div className="mt-1 flex items-end gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[40px] leading-[1.05]">收件箱</h1>
            <p className="mt-1 text-[12.5px] text-ink-3">
              被 inbox 绑定收集的记录事件。
              {data ? ` 未读 ${data.unread} 条` : ""}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Btn kind="line" onClick={() => select("@events")} className="h-8">事件绑定</Btn>
            <Btn kind="line" onClick={() => load()} className="h-8"><RefreshCw size={13} /> 刷新</Btn>
            <Btn kind="solid" onClick={readAll} disabled={!data?.unread} className="h-8 px-3"><CheckCheck size={14} /> 全部已读</Btn>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1">
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cx(
                "h-7 rounded-md px-2.5 text-[12.5px]",
                filter === value ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:text-ink",
              )}
            >
              {value === "all" ? "全部" : "未读"}
              {value === "unread" && data ? <span className="ml-1 font-mono text-[10.5px] text-ink-3">{data.unread}</span> : null}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto border-t border-line bg-surface">
        {data === null ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-raise" />)}
          </div>
        ) : !data.items.length ? (
          <Empty title={filter === "unread" ? "没有未读消息" : "收件箱是空的"}>
            在事件页新建绑定，动作选 <code className="font-mono text-ink-2">inbox</code>，命中后消息会出现在这里。
          </Empty>
        ) : (
          data.items.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              table={message.table_name ? byName[message.table_name] : undefined}
              open={expanded === message.id}
              raw={raw === message.id}
              onToggle={() => toggle(message)}
              onRaw={() => setRaw((id) => (id === message.id ? null : message.id))}
              onMark={(read) => mark(message, read)}
              onDelete={() => remove(message)}
              onOpen={() => message.table_name && message.record_id != null && openRecord({ table: message.table_name, id: message.record_id })}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MessageRow({ message, table, open, raw, onToggle, onRaw, onMark, onDelete, onOpen }: {
  message: InboxMessage;
  table: TableInfo | undefined;
  open: boolean;
  raw: boolean;
  onToggle: () => void;
  onRaw: () => void;
  onMark: (read: boolean) => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const unread = message.status === "unread";
  const clickable = message.op !== "delete" && message.record_id != null && !!table;
  const events = message.events ?? [];
  return (
    <article
      className={cx(
        "border-b border-line transition-colors",
        unread ? "bg-[color-mix(in_oklab,var(--accent-soft)_38%,var(--surface))]" : "bg-surface hover:bg-[color-mix(in_oklab,var(--raise)_60%,var(--surface))]",
      )}
    >
      <div className="flex gap-3 px-5 py-3.5">
        <span className={cx("mt-[7px] size-[7px] shrink-0 rounded-full", unread ? "bg-accent" : "bg-line-strong")} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
          <div className="flex items-baseline gap-2">
            <h2 className={cx("min-w-0 truncate text-[13.5px]", unread ? "font-semibold" : "font-medium")}>{message.title}</h2>
            {message.binding_name && (
              <span className="shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[10px] text-ink-3">{message.binding_name}</span>
            )}
            <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-3" title={clock(message.created_at)}>{relTime(message.created_at)}</span>
          </div>
          {message.body && !open && (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12.5px] text-ink-2">{message.body}</p>
          )}
          {message.prompt && !open && (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12.5px] text-ink-2">
              <span className="mr-1 font-mono text-[10.5px] text-ink-3">提示词</span>
              {message.prompt}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-3">
            {message.op && <span>{OP_LABEL[message.op] ?? message.op}</span>}
            {message.table_name && <span>{tableLabel(table, message.table_name)}{message.record_id != null ? ` #${message.record_id}` : ""}</span>}
            {message.events[0] && <ActorChip actor={message.events[0].actor} small />}
            <span className="ml-auto inline-flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => (e.stopPropagation(), onMark(unread))}
                className="rounded px-1 py-0.5 hover:bg-raise hover:text-ink"
              >
                {unread ? "标为已读" : "标为未读"}
              </button>
              <button type="button" onClick={(e) => (e.stopPropagation(), onDelete())} className="rounded px-1 py-0.5 hover:bg-raise hover:text-danger" title="删除">
                <Trash2 size={12} />
              </button>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-line/70 px-5 py-3 pl-[39px]">
          {message.prompt && (
            <div className="mb-2 rounded-md border border-line bg-raise px-2.5 py-2">
              <div className="font-mono text-[10.5px] text-ink-3">提示词</div>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{message.prompt}</p>
            </div>
          )}
          {message.body && <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{message.body}</p>}
          {events.map((event) => (
            <div key={event.seq} className="mt-2">
              <div className="font-mono text-[10.5px] text-ink-3">#{event.seq} · {OP_LABEL[event.op]} · {relTime(event.ts)}</div>
              <div className="mt-1 space-y-0.5">
                {Object.entries(event.fields).map(([key, diff]) => {
                  const field = table?.fields.find((f) => f.key === key);
                  return (
                    <div key={key} className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                      <span className="w-[120px] shrink-0 truncate text-ink-3" title={key}>{field ? fieldLabel(field) : key}</span>
                      <span className="max-w-[38%] shrink truncate text-ink-3 line-through decoration-ink-3/40">{brief(field, diff.before)}</span>
                      <span className="shrink-0 text-ink-3">→</span>
                      <span className="min-w-0 truncate font-medium">{brief(field, diff.after)}</span>
                    </div>
                  );
                })}
                {!Object.keys(event.fields).length && <span className="text-[12px] text-ink-3">没有用户字段变化</span>}
              </div>
            </div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            {clickable && (
              <Btn kind="line" onClick={onOpen} className="h-6 px-2 text-[11.5px]"><Inbox size={12} /> 打开记录</Btn>
            )}
            <Btn onClick={() => onMark(unread)} className="h-6 px-2 text-[11.5px]"><MailOpen size={12} /> {unread ? "标为已读" : "标为未读"}</Btn>
            <Btn onClick={onRaw} className="h-6 px-2 text-[11.5px]"><Code2 size={12} /> 原始事件</Btn>
          </div>
          {raw && (
            <pre className="mt-2 max-h-[320px] overflow-auto rounded-md border border-line bg-raise p-2.5 font-mono text-[11px] leading-relaxed text-ink-2">
              {JSON.stringify(events, null, 2)}
            </pre>
          )}
        </div>
      )}
    </article>
  );
}
