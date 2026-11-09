import type { Pulse } from "./components/graphBar";
import type { SimLink, SimNode } from "./graphModel";
import { endId, FADE_MS } from "./graphModel";
import { actorColor, actorName } from "./util";

/** 表的颜色，按表在域里的顺序分配；和操作者颜色错开色相。 */
export const TABLE_COLORS = ["#1c7ed6", "#2f9e44", "#e67700", "#ae3ec9", "#0c8599", "#c2255c", "#5f3dc4", "#66a80f", "#f08c00", "#868e96"];
export const PULSE_MS = 2600;

export interface Palette {
  ink: string;
  ink2: string;
  ink3: string;
  surface: string;
  danger: string;
  accent: string;
}

export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (k: string) => s.getPropertyValue(k).trim();
  return { ink: v("--ink"), ink2: v("--ink-2"), ink3: v("--ink-3"), surface: v("--surface"), danger: v("--danger"), accent: v("--accent") };
}

/** canvas 不认 CSS 变量，把 actorColor 给页面用户返回的 var(--ink-2) 换成实际颜色。 */
export const solid = (c: string, p: Palette) => (c.startsWith("var(") ? p.ink2 : c);

export function alpha(color: string, a: number) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function radius(n: SimNode) {
  if (n.kind === "actor") return 6;
  if (n.kind === "table") return 7 + Math.min(14, Math.sqrt(n.count ?? 0) * 0.9);
  return (n.child ? 3 : 4.5) + Math.min(6, Math.sqrt(n.deg ?? 0) * 1.1);
}

export interface DrawCtx {
  palette: Palette;
  color: (n: SimNode) => string;
  tableColor: (name: string | undefined) => string;
  selected: string | null;
  near: Set<string> | null;
  pulses: Map<string, Pulse>;
  /** 缩放不够时，只有连接数不低于它的记录显示标题 */
  labelDeg: number;
}

const VERB: Record<string, string> = { insert: "新建", update: "修改", delete: "删除" };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, p: Palette) {
  ctx.font = `${size}px "IBM Plex Sans", "PingFang SC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = size / 3;
  ctx.strokeStyle = p.surface;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function drawNode(n: SimNode, ctx: CanvasRenderingContext2D, scale: number, d: DrawCtx) {
  const x = n.x ?? 0, y = n.y ?? 0, r = radius(n), p = d.palette;
  const now = Date.now();
  const pulse = d.pulses.get(n.id);
  const age = pulse ? now - pulse.t : Infinity;
  const dim = d.near != null && !d.near.has(n.id);
  let a = dim ? 0.14 : 1;
  if (n.dying != null) a *= Math.max(0, 1 - (now - n.dying) / FADE_MS);
  if (pulse?.op === "insert" && age < 500) a *= age / 500;
  ctx.globalAlpha = a;

  ctx.beginPath();
  if (n.kind === "actor") ctx.roundRect(x - r, y - r, r * 2, r * 2, 2);
  else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = n.dying != null ? p.danger : d.color(n);
  ctx.fill();
  if (n.kind === "table") {
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = p.surface;
    ctx.stroke();
  }
  if (n.id === d.selected) {
    ctx.beginPath();
    ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = p.ink;
    ctx.stroke();
  }

  if (pulse && age < PULSE_MS && n.dying == null) {
    const c = solid(actorColor(pulse.actor), p);
    const k = Math.min(1, age / 1600);
    ctx.beginPath();
    ctx.arc(x, y, r + 2 + k * 16, 0, Math.PI * 2);
    ctx.lineWidth = 2.5 / scale;
    ctx.strokeStyle = alpha(c, 1 - k);
    ctx.stroke();
    const fade = age < PULSE_MS - 600 ? 1 : (PULSE_MS - age) / 600;
    ctx.globalAlpha = a * fade;
    const text = `${actorName(pulse.actor)} · ${VERB[pulse.op] ?? pulse.op}${pulse.fields.length ? " " + clip(pulse.fields.join("、"), 24) : ""}`;
    label(ctx, text, x, y - r - 6 - (1 - fade) * 4, 11 / scale, c, p);
    ctx.globalAlpha = a;
  }

  const show = n.kind !== "record" || scale > 1.6 || n.id === d.selected || (d.near?.has(n.id) ?? false) || (n.deg ?? 0) >= d.labelDeg;
  if (show && !dim) {
    const text = n.kind === "table" ? `${n.title} · ${n.count}` : clip(n.title, 18);
    const size = (n.kind === "record" ? 10 : 12) / scale;
    label(ctx, text, x, y + r + size * 0.9, size, n.kind === "actor" ? solid(actorColor(n.title), p) : p.ink2, p);
  }
  ctx.globalAlpha = 1;
}

/** 选中节点时，只有和它相连的边保持原样。 */
const faded = (l: SimLink, d: DrawCtx) => d.selected != null && endId(l.source) !== d.selected && endId(l.target) !== d.selected;

export function linkColor(l: SimLink, d: DrawCtx) {
  const now = Date.now(), p = d.palette;
  if (l.dying != null) return alpha(p.danger, Math.max(0, 1 - (now - l.dying) / FADE_MS));
  if (l.born != null && now - l.born < 1500) return p.accent;
  const k = faded(l, d) ? 0.15 : 1;
  if (l.kind === "actor") return alpha(solid(actorColor(endId(l.source).slice(2)), p), 0.35 * k);
  if (l.kind === "link") return alpha(d.tableColor(l.owner), 0.6 * k);
  return alpha(p.ink3, 0.55 * k);
}

export function linkWidth(l: SimLink, d: DrawCtx, tablesView: boolean) {
  if (l.born != null && Date.now() - l.born < 1500) return 2.5;
  if (tablesView) return 1 + Math.min(5, Math.log2(1 + (l.count ?? 0)) * 0.6);
  const base = l.kind === "actor" ? 0.6 + Math.min(1.6, (l.count ?? 1) * 0.15) : 1;
  return d.selected != null && !faded(l, d) ? base + 0.8 : base;
}
