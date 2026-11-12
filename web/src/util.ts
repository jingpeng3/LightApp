import { useSyncExternalStore } from "react";
import type { Attachment, Field, Rec, TableInfo } from "./api";
import { ACTOR, ApiError } from "./api";

const ACTOR_COLORS = ["#d9480f", "#1c7ed6", "#2f9e44", "#ae3ec9", "#e67700", "#0c8599", "#c2255c", "#5f3dc4"];

/** 每个操作者固定一种颜色；页面上的人（web）统一用墨色。 */
export function actorColor(actor: string | null | undefined) {
  if (!actor || actor === ACTOR) return "var(--ink-2)";
  let h = 0;
  for (const c of actor) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ACTOR_COLORS[h % ACTOR_COLORS.length];
}

export function actorName(actor: string | null | undefined) {
  return !actor ? "?" : actor === ACTOR ? "我" : actor;
}

export function relTime(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const fieldLabel = (f: Field) => f.label || f.key;
export const tableLabel = (t: TableInfo | undefined, name: string) => t?.label || name;

/** 地址栏路由是 #域/表；带了 _id 就直接打开这条记录的全屏视图。 */
export function tableHash(domain: string, table: string | null) {
  return `#${encodeURIComponent(domain)}${table ? `/${encodeURIComponent(table)}` : ""}`;
}

export function recordHash(domain: string, table: string, id: number) {
  return `${tableHash(domain, table)}/${id}`;
}

export function asList<T>(v: unknown): T[] {
  return v == null ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}

/** 记录的标题：第一个有值的文本字段，否则用 #id。 */
export function recTitle(table: TableInfo | undefined, rec: Rec | null | undefined) {
  if (!rec) return "";
  const f = table?.fields.find((x) => (x.type === "text" || x.type === "long_text") && rec[x.key]);
  return f ? String(rec[f.key]) : `#${rec._id}`;
}

/** 值的简短文字表示，用在动态流和表格提示里。 */
export function brief(field: Field | undefined, value: unknown): string {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "空";
  if (field?.type === "checkbox") return value ? "是" : "否";
  if (field?.type === "attachment") return asList<Attachment>(value).map((a) => a.name).join("、");
  if (field?.type === "link") return asList<number>(value).map((v) => `#${v}`).join(" ");
  if (Array.isArray(value)) return value.join("、");
  const s = String(value);
  return s.length > 40 ? s.slice(0, 40) + "…" : s;
}

/** before/after 之间变了哪些用户字段。 */
export function diffKeys(before: Rec | null, after: Rec | null) {
  if (!before || !after) return [];
  return Object.keys(after).filter((k) => !k.startsWith("_") && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

// ---------- 提示消息 ----------

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
  hint?: string | null;
}

let toasts: Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((fn) => fn());

export function toast(kind: Toast["kind"], message: string, hint?: string | null) {
  const id = ++toastSeq;
  toasts = [...toasts, { id, kind, message, hint }].slice(-4);
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, kind === "error" ? 6000 : 3000);
}

export function toastError(e: unknown) {
  if (e instanceof ApiError) toast("error", e.message, e.hint);
  else toast("error", String(e));
}

export function useToasts() {
  return useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => void toastListeners.delete(fn);
    },
    () => toasts,
  );
}

// ---------- 确认框 ----------

export interface Ask {
  title: string;
  body?: string;
  ok?: string;
  resolve: (yes: boolean) => void;
}

let asking: Ask | null = null;
const askListeners = new Set<() => void>();

/** 页面内的确认框，代替 window.confirm；同一时间只有一个，新的会把旧的当作取消。 */
export function ask(title: string, opts: { body?: string; ok?: string } = {}) {
  asking?.resolve(false);
  return new Promise<boolean>((resolve) => {
    asking = {
      title, ...opts,
      resolve: (yes) => {
        asking = null;
        askListeners.forEach((fn) => fn());
        resolve(yes);
      },
    };
    askListeners.forEach((fn) => fn());
  });
}

export function useAsk() {
  return useSyncExternalStore(
    (fn) => {
      askListeners.add(fn);
      return () => void askListeners.delete(fn);
    },
    () => asking,
  );
}

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
