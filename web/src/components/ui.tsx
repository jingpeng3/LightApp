import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Attachment, FieldType, TableInfo } from "../api";
import { actorColor, actorName, cx } from "../util";

export interface Target {
  table: string;
  id: number;
}

export interface PreviewTarget {
  recordId: number;
  field: string;
  idx: number;
  item: Attachment;
}

export interface AppCtx {
  domain: string;
  tables: TableInfo[];
  byName: Record<string, TableInfo>;
  select: (name: string) => void;
  openRecord: (t: Target) => void;
  openFull: (t: Target) => void;
  openNew: (table: string, parentId?: number | null) => void;
  preview: (p: PreviewTarget) => void;
}

export const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);

export function Tag({ value, color, dim }: { value: string; color?: string; dim?: boolean }) {
  const c = color || "gray";
  return (
    <span
      className={cx("inline-flex h-[20px] max-w-full items-center rounded-[4px] px-1.5 text-[12px] leading-none whitespace-nowrap", dim && "opacity-50")}
      style={{ background: `var(--opt-${c}-bg)`, color: `var(--opt-${c}-fg)` }}
    >
      <span className="truncate">{value}</span>
    </span>
  );
}

export function ActorChip({ actor, small }: { actor: string | null | undefined; small?: boolean }) {
  const color = actorColor(actor);
  return (
    <span className={cx("inline-flex items-center gap-1 font-mono whitespace-nowrap", small ? "text-[11px]" : "text-[12px]")} style={{ color }}>
      <span className="inline-block size-[7px] rounded-full" style={{ background: color }} />
      {actorName(actor)}
    </span>
  );
}

const GLYPHS: Record<FieldType, string> = {
  text: "Aa", long_text: "¶", number: "#", date: "▦", datetime: "◷", checkbox: "☑", single_select: "◉",
  multi_select: "◎", url: "↗", email: "@", person: "☺", auto_number: "№", link: "⇄", attachment: "⎘",
};

export function TypeGlyph({ type }: { type: FieldType }) {
  return (
    <span className="inline-block w-[18px] shrink-0 text-center font-mono text-[11px] text-ink-3" title={type}>
      {GLYPHS[type]}
    </span>
  );
}

export function Btn({ children, onClick, kind = "ghost", title, disabled, className }: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "ghost" | "solid" | "line" | "danger";
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors disabled:opacity-40",
        kind === "ghost" && "text-ink-2 hover:bg-raise hover:text-ink",
        kind === "line" && "border border-line-strong text-ink-2 hover:border-ink-3 hover:text-ink",
        kind === "solid" && "bg-ink text-surface hover:bg-accent",
        kind === "danger" && "text-danger hover:bg-[color-mix(in_oklab,var(--danger)_12%,transparent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** 挂在 body 上的浮层，按锚点元素定位，点外面或按 Esc 关闭。 */
export function Popover({ anchor, onClose, children, width, align = "start" }: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = width ?? Math.max(r.width, 220);
      let left = align === "end" ? r.right - w : r.left;
      left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const h = ref.current?.offsetHeight ?? 0;
      const top = below >= Math.min(h, 320) || below >= above ? r.bottom + 4 : Math.max(8, r.top - 4 - Math.min(h, above));
      setPos({ top, left, maxH: Math.max(160, below >= above ? below : above) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width, align]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="fade-in fixed z-50 overflow-auto rounded-lg border border-line-strong bg-surface shadow-[var(--shadow)]"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: width ?? (anchor ? Math.max(anchor.offsetWidth, 220) : 220), maxHeight: pos?.maxH }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="font-display text-[28px] italic text-ink-3">{title}</div>
      {children && <div className="max-w-md text-[12.5px] leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}
