import { useCallback, useEffect, useRef, useState } from "react";
import type { Field, FileStatuses, Rec, TableInfo } from "./api";
import { ACTOR, api, ApiError } from "./api";
import { useChanges } from "./live";
import { actorName, diffKeys, toast, toastError } from "./util";

export interface Flash {
  actor: string | null;
  n: number;
}

/** 当前看的是哪一页、怎么排序、搜什么。分页、排序、搜索都在服务端做。 */
export interface View {
  page: number;
  pageSize: number;
  sort: string | null;
  search: string;
}

// contains 在这些字段上是子串匹配；多选等数组字段的 contains 要求选项值精确匹配，不参与搜索
const SEARCHABLE: Field["type"][] = ["text", "long_text", "url", "email", "person", "single_select"];

/** 搜索框的文字转成查询条件：数字同时按 _id 匹配，其余在文本类字段里找子串。 */
function searchWhere(table: TableInfo, search: string) {
  const q = search.trim();
  if (!q) return null;
  const or: Record<string, unknown>[] = table.fields.filter((f) => SEARCHABLE.includes(f.type)).map((f) => ({ [f.key]: { contains: q } }));
  if (/^\d+$/.test(q)) or.push({ _id: Number(q) });
  return or.length ? { $or: or } : { _id: -1 };
}

/** 一张表（或某个父记录下的子表）的一页记录，跟随实时变更更新，并记录需要高亮的单元格。 */
export function useRecords(table: TableInfo, parentId: number | null | undefined, view: View) {
  const name = table.name;
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // 不在当前页实时展示的新增数（翻到了后面的页、按其他列排序、或在搜索时）
  const [stale, setStale] = useState(0);
  const reqSeq = useRef(0);
  const [flashes, setFlashes] = useState<Record<string, Flash>>({});
  const [entering, setEntering] = useState<Set<number>>(new Set());
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [statuses, setStatuses] = useState<FileStatuses>({});
  const flashSeq = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hasFiles = table.fields.some((f) => f.type === "attachment");

  const { page, pageSize, sort, search } = view;
  const where = JSON.stringify(searchWhere(table, search));
  // 实时插入的新记录只有在「第一页、默认按新到旧、没有搜索」时才直接出现在表格里
  const liveHead = page === 0 && !sort && !search.trim();

  const load = useCallback(() => {
    const n = ++reqSeq.current;
    setLoading(true);
    api.query(name, { where: JSON.parse(where), sort: sort ?? "-_id", limit: pageSize, offset: page * pageSize, parent_id: parentId ?? null })
      .then((r) => {
        if (n !== reqSeq.current) return; // 翻页太快时丢弃过期的响应
        setRows(r.items);
        setTotal(r.total);
        setStale(0);
      }, toastError)
      .finally(() => n === reqSeq.current && setLoading(false));
  }, [name, parentId, where, sort, page, pageSize]);

  useEffect(() => setRows(null), [name, parentId]);

  useEffect(() => {
    load();
  }, [load, table.schema_version]);

  const refreshStatus = useCallback(
    (ids: number[]) => {
      if (!hasFiles || !ids.length) return;
      api.fileStatus(ids).then((s) => setStatuses((prev) => ({ ...prev, ...s })), () => {});
    },
    [hasFiles],
  );

  // 加载后、切回页面时、以及每 20 秒检查一次附件是否丢失或变更
  useEffect(() => {
    if (!rows || !hasFiles) return;
    const ids = rows.filter((r) => table.fields.some((f) => f.type === "attachment" && r[f.key] != null)).map((r) => r._id);
    refreshStatus(ids);
    const timer = setInterval(() => document.visibilityState === "visible" && refreshStatus(ids), 20000);
    const onFocus = () => refreshStatus(ids);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [rows, hasFiles, table.fields, refreshStatus]);

  const flash = useCallback((id: number, keys: string[], actor: string | null) => {
    const n = ++flashSeq.current;
    setFlashes((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [`${id}:${k}`, { actor, n }])) }));
    setTimeout(() => {
      setFlashes((prev) => {
        const next = { ...prev };
        for (const k of keys) if (next[`${id}:${k}`]?.n === n) delete next[`${id}:${k}`];
        return next;
      });
    }, 2100);
  }, []);

  const mark = (set: typeof setEntering, id: number, ms: number) => {
    set((s) => new Set(s).add(id));
    setTimeout(() => set((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    }), ms);
  };

  useChanges((c) => {
    if (c.table_name !== name) return;
    if (c.op === "alter_table") return; // schema_version 变化时整体重新加载
    const id = c.record_id!;
    if (c.op === "insert" && c.after) {
      if (parentId != null && c.after._parent_id !== parentId) return;
      const after = c.after;
      if (!rowsRef.current || rowsRef.current.some((r) => r._id === id)) return;
      if (!liveHead) return setStale((n) => n + 1);
      setRows((rs) => (rs && !rs.some((r) => r._id === id) ? [after, ...rs].slice(0, pageSize) : rs));
      setTotal((t) => t + 1);
      mark(setEntering, id, 700);
      refreshStatus([id]);
    } else if (c.op === "update" && c.after) {
      const after = c.after;
      setRows((rs) => rs?.map((r) => (r._id === id && r._version < after._version ? after : r)) ?? rs);
      if (c.actor !== ACTOR) flash(id, diffKeys(c.before, c.after), c.actor);
      refreshStatus([id]);
    } else if (c.op === "delete") {
      if (parentId != null && c.before?._parent_id !== parentId) return;
      if (!rowsRef.current?.some((r) => r._id === id)) {
        // 删掉的是别的页上的记录：没有搜索时总数一定少一条，有搜索时不确定是否命中
        if (search.trim()) setStale((n) => n + 1);
        else setTotal((t) => Math.max(0, t - 1));
        return;
      }
      mark(setLeaving, id, 460);
      setTimeout(() => {
        if (!rowsRef.current?.some((r) => r._id === id)) return;
        setRows((rs) => rs?.filter((r) => r._id !== id) ?? rs);
        setTotal((t) => t - 1);
      }, 450);
    }
  });

  /** 页面上修改一个字段。成功返回 true；版本冲突时重新读取这一行。 */
  const update = useCallback(
    async (rec: Rec, set: Record<string, unknown>) => {
      try {
        const next = await api.update(name, rec._id, set, rec._version);
        setRows((rs) => rs?.map((r) => (r._id === next._id && r._version <= next._version ? next : r)) ?? rs);
        refreshStatus([rec._id]);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "version_conflict") {
          const fresh = await api.get(name, rec._id).catch(() => null);
          if (fresh) setRows((rs) => rs?.map((r) => (r._id === fresh._id ? fresh : r)) ?? rs);
          toast("error", `这条记录刚被 ${actorName(fresh?._updated_by)} 修改过，已刷新为最新内容`, "确认后再改一次");
        } else toastError(e);
        return false;
      }
    },
    [name, refreshStatus],
  );

  return { rows, total, loading, stale, flashes, entering, leaving, statuses, update, reload: load };
}
