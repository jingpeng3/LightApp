import { Check, ExternalLink } from "lucide-react";
import type { Attachment, Field, FileState, Rec } from "../api";
import { asList, cx } from "../util";
import { AttachmentChip } from "./attachments";
import { Tag, useApp } from "./ui";

export function optionColor(f: Field, value: string) {
  return f.options?.find((o) => o.value === value)?.color;
}

/** 表格单元格和抽屉里的只读展示。 */
export function CellView({ field: f, value, rec, states }: {
  field: Field;
  value: unknown;
  rec: Rec;
  states?: FileState[];
}) {
  const { openRecord } = useApp();
  if (f.type === "checkbox") {
    return (
      <span className={cx("inline-flex size-[15px] items-center justify-center rounded-[3px] border", value ? "border-accent bg-accent text-surface" : "border-line-strong")}>
        {!!value && <Check size={11} strokeWidth={3} />}
      </span>
    );
  }
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return null;
  switch (f.type) {
    case "single_select":
      return <Tag value={String(value)} color={optionColor(f, String(value))} dim={!f.options?.some((o) => o.value === value)} />;
    case "multi_select":
      return (
        <span className="flex min-w-0 gap-1 overflow-hidden">
          {asList<string>(value).map((v) => <Tag key={v} value={v} color={optionColor(f, v)} />)}
        </span>
      );
    case "number":
    case "auto_number":
      return <span className="block text-right font-mono">{f.type === "auto_number" ? String(value).padStart(3, "0") : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 })}</span>;
    case "date":
      return <span className="font-mono text-ink-2">{String(value)}</span>;
    case "datetime":
      return <span className="font-mono text-ink-2">{new Date(String(value)).toLocaleString("zh-CN", { hour12: false })}</span>;
    case "url":
      return (
        <a href={String(value)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline">
          <span className="truncate">{String(value).replace(/^https?:\/\//, "")}</span>
          <ExternalLink size={11} className="shrink-0" />
        </a>
      );
    case "email":
      return <a href={`mailto:${value}`} onClick={(e) => e.stopPropagation()} className="truncate text-accent hover:underline">{String(value)}</a>;
    case "person":
      return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-raise text-[10px] font-medium text-ink-2 ring-1 ring-line-strong">
            {String(value).slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{String(value)}</span>
        </span>
      );
    case "link":
      return (
        <span className="flex min-w-0 gap-1 overflow-hidden">
          {asList<number>(value).map((id) => (
            <button
              key={id}
              type="button"
              onClick={(e) => (e.stopPropagation(), openRecord({ table: f.config!.table!, id }))}
              className="h-[20px] shrink-0 rounded-[4px] border border-line-strong px-1.5 font-mono text-[11.5px] text-ink-2 hover:border-accent hover:text-accent"
            >
              {f.config!.table}#{id}
            </button>
          ))}
        </span>
      );
    case "attachment":
      return (
        <span className="flex min-w-0 gap-1 overflow-hidden">
          {asList<Attachment>(value).map((a, i) => (
            <AttachmentChip key={a.path} item={a} state={states?.[i]} recordId={rec._id} field={f.key} idx={i} />
          ))}
        </span>
      );
    case "long_text":
      return <span className="truncate text-ink-2">{String(value).split("\n")[0]}</span>;
    default:
      return <span className="truncate">{String(value)}</span>;
  }
}
