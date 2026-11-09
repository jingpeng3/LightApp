export type FieldType =
  | "text" | "long_text" | "number" | "date" | "datetime" | "checkbox" | "single_select" | "multi_select"
  | "url" | "email" | "person" | "auto_number" | "link" | "attachment";

export interface Option {
  value: string;
  color: string;
}

export interface Field {
  key: string;
  type: FieldType;
  label?: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  options?: Option[];
  config?: { table?: string; multiple?: boolean; accept?: string[] };
}

export interface TableInfo {
  name: string;
  label: string | null;
  description: string | null;
  parent: string | null;
  relation?: "one_to_many" | "one_to_one";
  on_delete?: "cascade" | "restrict";
  schema_version: number;
  record_count: number;
  fields: Field[];
  children: string[];
}

export interface Rec {
  _id: number;
  _parent_id: number | null;
  _version: number;
  _created_at: string;
  _updated_at: string;
  _created_by: string | null;
  _updated_by: string | null;
  [key: string]: unknown;
}

export interface Attachment {
  path: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  mime?: string | null;
  sha256?: string;
  mtime: string;
  file_count?: number;
  added_at: string;
  added_by: string;
}

export type FileState = "ok" | "missing" | "changed";
export type FileStatuses = Record<string, Record<string, FileState[]>>;

export interface Domain {
  name: string;
  label: string | null;
  description: string | null;
  table_count: number;
  record_count: number;
}

export interface Change {
  seq: number;
  tx: string;
  domain: string | null;
  table_name: string;
  record_id: number | null;
  op: "insert" | "update" | "delete" | "create_table" | "alter_table" | "drop_table" | "create_domain" | "alter_domain" | "drop_domain";
  before: Rec | null;
  after: Rec | null;
  actor: string | null;
  ts: string;
}

export type EventOp = "insert" | "update" | "delete";

export interface EventItem {
  seq: number;
  op: EventOp;
  domain: string;
  table: string;
  record_id: number;
  actor: string | null;
  ts: string;
  fields: Record<string, { before: unknown; after: unknown }>;
  record: Rec;
}

export type BindingAction = "webhook" | "command" | "write" | "inbox";

export interface Binding {
  id: number;
  domain: string;
  name: string;
  ops: EventOp[];
  table_name: string | null;
  field: string | null;
  where: Record<string, unknown> | null;
  where_before: Record<string, unknown> | null;
  action: BindingAction;
  config: Record<string, unknown>;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Delivery {
  id: number;
  binding_id: number;
  change_seq: number;
  last_seq: number | null;
  seqs: number[] | null;
  event_count: number;
  status: "pending" | "sent" | "failed";
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxMessage {
  id: number;
  domain: string;
  binding_id: number | null;
  binding_name: string | null;
  event_seq: number | null;
  table_name: string | null;
  record_id: number | null;
  op: EventOp | null;
  title: string;
  body: string | null;
  events: EventItem[];
  status: "unread" | "read";
  created_at: string;
  read_at: string | null;
}

export interface InboxPage {
  items: InboxMessage[];
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

export interface GraphNode {
  id: number;
  table: string;
  title: string;
  parent_id: number | null;
  created_by: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface GraphEdge {
  source: number;
  target: number;
  kind: "parent" | "link";
  field?: string;
}

export interface TableEdge {
  source: string;
  target: string;
  kind: "parent" | "link";
  field?: string;
  count: number;
}

export interface GraphData {
  seq: number;
  total: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  touches: { actor: string; record_id: number; count: number }[];
  table_edges: TableEdge[];
}

export interface QueryBody {
  where?: Record<string, unknown> | null;
  sort?: string | null;
  limit?: number;
  offset?: number;
  include?: string | null;
  parent_id?: number | null;
}

export class ApiError extends Error {
  code: string;
  hint: string | null;
  constructor(code: string, message: string, hint: string | null) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export const ACTOR = "web";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch("/api" + path, {
      method,
      headers: { "Content-Type": "application/json", "X-DT-Actor": ACTOR },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", "连不上 dt 服务", "确认 dt serve 正在运行");
  }
  const json = await resp.json().catch(() => null);
  if (!json?.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.code ?? "internal", e.message ?? `HTTP ${resp.status}`, e.hint ?? null);
  }
  return json.data as T;
}

/** 页面当前所在的域；表、记录、变更接口都在域下面。 */
let domain = "";
export const setDomain = (d: string) => void (domain = d);
const d = () => `/d/${encodeURIComponent(domain)}`;
const t = (name: string) => `${d()}/tables/${encodeURIComponent(name)}`;

export const api = {
  domains: () => req<Domain[]>("GET", "/domains"),
  tables: () => req<TableInfo[]>("GET", `${d()}/tables`),
  query: (table: string, body: QueryBody) => req<{ items: Rec[]; total: number }>("POST", `${t(table)}/query`, body),
  get: (table: string, id: number) => req<Rec>("GET", `${t(table)}/records/${id}`),
  insert: (table: string, data: Record<string, unknown>, parent_id?: number | null) =>
    req<Rec>("POST", `${t(table)}/records`, { data, parent_id: parent_id ?? null }),
  update: (table: string, id: number, set: Record<string, unknown>, if_version?: number) =>
    req<Rec>("PATCH", `${t(table)}/records/${id}`, { set, if_version }),
  remove: (table: string, id: number) =>
    req<{ deleted: { table: string; _id: number }[] }>("DELETE", `${t(table)}/records/${id}`),
  changes: (params: Record<string, string | number>) =>
    req<Change[]>("GET", `${d()}/changes?` + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))),
  events: (params: Record<string, string | number | undefined>) =>
    req<{ items: EventItem[]; seq: number }>("GET", `${d()}/events?` + query(params)),
  bindings: () => req<Binding[]>("GET", `${d()}/bindings`),
  createBinding: (body: Record<string, unknown>) => req<Binding>("POST", `${d()}/bindings`, body),
  updateBinding: (name: string, body: Record<string, unknown>) =>
    req<Binding>("PATCH", `${d()}/bindings/${encodeURIComponent(name)}`, body),
  deleteBinding: (name: string) => req<{ deleted: string }>("DELETE", `${d()}/bindings/${encodeURIComponent(name)}`),
  deliveries: (name: string, params: Record<string, string | number | undefined>) =>
    req<Delivery[]>("GET", `${d()}/bindings/${encodeURIComponent(name)}/deliveries?` + query(params)),
  retryBinding: (name: string) =>
    req<{ retried: number }>("POST", `${d()}/bindings/${encodeURIComponent(name)}/retry`),
  inbox: (params: Record<string, string | number | undefined>) =>
    req<InboxPage>("GET", `${d()}/inbox?` + query(params)),
  markInbox: (id: number, status: "read" | "unread") =>
    req<InboxMessage>("PATCH", `${d()}/inbox/${id}`, { status }),
  readAllInbox: () => req<{ updated: number }>("POST", `${d()}/inbox/read-all`),
  deleteInbox: (id: number) => req<{ deleted: number }>("DELETE", `${d()}/inbox/${id}`),
  graph: (params: Record<string, string | number | undefined>) => req<GraphData>("GET", `${d()}/graph?` + query(params)),
  fileStatus: (record_ids: number[]) => req<FileStatuses>("POST", "/files/status", { record_ids }),
  tree: (id: number, field: string, idx: number) =>
    req<{ files: { path: string; size: number }[]; truncated: boolean }>("GET", `/files/${id}/${field}/${idx}/tree`),
};

function query(params: Record<string, string | number | undefined>) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]),
  ).toString();
}

export function fileUrl(id: number, field: string, idx: number, sub?: string) {
  const url = `/api/files/${id}/${encodeURIComponent(field)}/${idx}`;
  return sub ? `${url}?sub=${encodeURIComponent(sub)}` : url;
}
