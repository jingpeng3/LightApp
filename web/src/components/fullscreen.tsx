import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FileStatuses, Rec } from "../api";
import { api, ApiError } from "../api";
import { useChanges } from "../live";
import { fieldLabel, recTitle, relTime, tableLabel, toastError } from "../util";
import { CellView } from "./cells";
import { ChildTabs } from "./children";
import { ActorChip, Btn, Empty, useApp, type Target } from "./ui";

/** 单条记录的全屏视图：顶部只保留记录信息，剩下的空间整块看子表。 */
export function FullScreenRecord({ target, onClose }: { target: Target; onClose: () => void }) {
  const { byName, openFull } = useApp();
  const table = byName[target.table];
  const [rec, setRec] = useState<Rec | null>(null);
  const [gone, setGone] = useState(false);
  const [statuses, setStatuses] = useState<FileStatuses>({});

  const load = useCallback(() => {
    setGone(false);
    api.get(target.table, target.id).then(setRec, (e) => (e instanceof ApiError && e.code === "not_found" ? setGone(true) : toastError(e)));
    api.fileStatus([target.id]).then(setStatuses, () => {});
  }, [target]);

  useEffect(() => {
    setRec(null);
    load();
  }, [load]);

  useChanges((c) => {
    if (c.table_name !== target.table || c.record_id !== target.id) return;
    if (c.op === "delete") return setGone(true);
    if (c.op === "update" && c.after) {
      setRec((r) => (r && r._version < c.after!._version ? c.after : r));
      api.fileStatus([target.id]).then(setStatuses, () => {});
    }
  });

  // 上层还有抽屉、预览或浮层时，Esc 交给它们处理
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".fixed.z-30, .fixed.z-40, .fixed.z-50") && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  if (!table) return null;
  const parent = table.parent ? byName[table.parent] : undefined;
  const fields = rec
    ? table.fields.filter((f) => {
      const v = rec[f.key];
      return f.type === "checkbox" ? v != null : v != null && v !== "" && !(Array.isArray(v) && !v.length);
    })
    : [];

  return (
    <div className="fade-in fixed inset-0 z-20 flex flex-col bg-surface">
      <header className="flex items-start gap-4 border-b border-line bg-panel px-6 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
            {parent && rec?._parent_id != null && (
              <>
                <button type="button" onClick={() => openFull({ table: parent.name, id: rec._parent_id! })} className="hover:text-accent">
                  {tableLabel(parent, parent.name)} #{rec._parent_id}
                </button>
                <span>/</span>
              </>
            )}
            <span>{tableLabel(table, table.name)}</span>
            <span className="text-ink-2">#{target.id}</span>
          </div>
          <h2 className="mt-0.5 truncate font-display text-[30px] leading-[1.1]">{gone ? "记录已删除" : rec ? recTitle(table, rec) : "…"}</h2>
          {rec && (
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              <span className="inline-flex items-center gap-1">创建 <ActorChip actor={rec._created_by} small /> {relTime(rec._created_at)}</span>
              <span className="inline-flex items-center gap-1">更新 <ActorChip actor={rec._updated_by} small /> {relTime(rec._updated_at)}</span>
              <span className="font-mono">v{rec._version}</span>
            </div>
          )}
        </div>
        <Btn onClick={onClose} title="关闭 (Esc)"><X size={16} /></Btn>
      </header>

      {gone ? (
        <div className="p-8 text-ink-3">这条记录已经被删除。</div>
      ) : !rec ? (
        <div className="p-8 text-ink-3">读取中…</div>
      ) : (
        <>
          {fields.length > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-line px-6 py-3">
              {fields.map((f) => (
                <div key={f.key} className="max-w-[420px] min-w-[120px]">
                  <div className="truncate font-mono text-[10.5px] tracking-wide text-ink-3 uppercase" title={f.key}>{fieldLabel(f)}</div>
                  <div className="mt-0.5 flex min-w-0 text-[13px]">
                    {f.type === "long_text" ? (
                      <span className="line-clamp-2 whitespace-pre-wrap text-ink-2">{String(rec[f.key])}</span>
                    ) : (
                      <CellView field={f} value={rec[f.key]} rec={rec} states={statuses[rec._id]?.[f.key]} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {table.children.length > 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ChildTabs table={table} parentId={rec._id} full />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Empty title="没有子表">{tableLabel(table, table.name)} 下没有子表。</Empty>
            </div>
          )}
        </>
      )}
    </div>
  );
}
