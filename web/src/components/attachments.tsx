import { AlertTriangle, ChevronRight, Copy, Download, ExternalLink, File, FileCode2, FileImage, FileText, Folder, FolderOpen, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Attachment, FileState } from "../api";
import { api, fileUrl } from "../api";
import { clock, cx, fmtSize, toast, toastError } from "../util";
import { ActorChip, useApp, type PreviewTarget } from "./ui";

const Markdown = lazy(() => import("./markdown"));

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const TEXT = /\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|r|lua|vue|svelte|dockerfile|makefile|gitignore|diff|patch)$/i;
const MAX_TEXT = 2 * 1024 * 1024;

type Kind = "image" | "markdown" | "pdf" | "text" | "other";

export function previewKind(name: string): Kind {
  if (IMAGE.test(name)) return "image";
  if (/\.(md|markdown|mdx)$/i.test(name)) return "markdown";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (TEXT.test(name) || !name.includes(".")) return "text";
  return "other";
}

function KindIcon({ name, dir, size = 13 }: { name: string; dir?: boolean; size?: number }) {
  if (dir) return <Folder size={size} />;
  const k = previewKind(name);
  if (k === "image") return <FileImage size={size} />;
  if (k === "markdown" || k === "pdf") return <FileText size={size} />;
  if (k === "text") return <FileCode2 size={size} />;
  return <File size={size} />;
}

const STATE_TEXT: Record<Exclude<FileState, "ok">, string> = { missing: "文件已丢失", changed: "文件已变更" };

export function StateBadge({ state }: { state?: FileState }) {
  if (!state || state === "ok") return null;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-[3px] px-1 text-[10.5px] font-medium", state === "missing" ? "bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] text-danger" : "bg-[color-mix(in_oklab,var(--warn)_16%,transparent)] text-warn")}>
      <AlertTriangle size={10} />
      {STATE_TEXT[state]}
    </span>
  );
}

export function AttachmentChip({ item, state, recordId, field, idx }: { item: Attachment; state?: FileState; recordId: number; field: string; idx: number }) {
  const { preview } = useApp();
  const bad = state === "missing";
  return (
    <span
      className={cx(
        "inline-flex h-[20px] max-w-[180px] shrink-0 items-center rounded-[4px] border text-[12px] transition-colors",
        bad ? "border-dashed border-danger/60 text-danger line-through decoration-danger/50" : state === "changed" ? "border-warn/60 text-ink" : "border-line-strong text-ink hover:border-accent hover:text-accent",
      )}
    >
      <button
        type="button"
        title={`${item.path}${state && state !== "ok" ? `\n${STATE_TEXT[state]}` : ""}`}
        onClick={(e) => (e.stopPropagation(), preview({ recordId, field, idx, item }))}
        className="inline-flex h-full min-w-0 items-center gap-1 pr-1 pl-1.5"
      >
        <span className={cx("shrink-0", !bad && "text-ink-3")}><KindIcon name={item.name} dir={item.kind === "dir"} size={12} /></span>
        <span className="truncate">{item.name}</span>
        {state === "changed" && <span className="size-[6px] shrink-0 rounded-full bg-warn" />}
      </button>
      {/* 目录附件必须带 sub 才能读文件，外部打开放到预览面板里 */}
      {item.kind === "file" && (
        <a
          href={fileUrl(recordId, field, idx)}
          target="_blank"
          rel="noopener noreferrer"
          title="在新标签页打开"
          onClick={(e) => e.stopPropagation()}
          className="flex h-full items-center pr-1 pl-0.5 text-ink-3 hover:text-accent"
        >
          <ExternalLink size={10} />
        </a>
      )}
    </span>
  );
}

/** 附件预览：右侧大面板。目录附件左边是文件树，右边预览选中的文件。 */
export function PreviewModal({ target, state, onClose }: { target: PreviewTarget; state?: FileState; onClose: () => void }) {
  const { item, recordId, field, idx } = target;
  const isDir = item.kind === "dir";
  const [sub, setSub] = useState<string | null>(null);
  const [tree, setTree] = useState<{ files: { path: string; size: number }[]; truncated: boolean } | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  useEffect(() => {
    if (!isDir || state === "missing") return;
    api.tree(recordId, field, idx).then((t) => {
      setTree(t);
      const first = t.files.find((f) => /(^|\/)(index\.html?|readme\.md)$/i.test(f.path)) ?? t.files.find((f) => previewKind(f.path) !== "other") ?? t.files[0];
      setSub(first?.path ?? null);
    }, toastError);
  }, [isDir, recordId, field, idx, state]);

  const name = isDir ? sub ?? "" : item.name;
  const url = isDir ? (sub ? fileUrl(recordId, field, idx, sub) : null) : fileUrl(recordId, field, idx);
  const size = isDir ? tree?.files.find((f) => f.path === sub)?.size ?? 0 : item.size;

  return (
    <div className="fade-in fixed inset-0 z-40 flex bg-[color-mix(in_oklab,var(--ink)_28%,transparent)] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="drawer m-3 ml-auto flex w-[min(1100px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[var(--shadow)]" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
          <span className="mt-1 text-ink-3"><KindIcon name={item.name} dir={isDir} size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-display text-[24px] leading-tight">{item.name}</h2>
              <StateBadge state={state} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-ink-3">
              <button type="button" title="复制路径" onClick={() => navigator.clipboard.writeText(item.path).then(() => toast("info", "路径已复制"))} className="inline-flex max-w-[520px] items-center gap-1 hover:text-ink">
                <span className="truncate">{item.path}</span>
                <Copy size={11} className="shrink-0" />
              </button>
              <span>{isDir ? `${item.file_count} 个文件 · ${fmtSize(item.size)}` : fmtSize(item.size)}</span>
              <span className="inline-flex items-center gap-1">登记 <ActorChip actor={item.added_by} small /> {clock(item.added_at)}</span>
              {item.sha256 && <span title={item.sha256}>sha256 {item.sha256.slice(0, 10)}</span>}
            </div>
          </div>
          {url && state !== "missing" && (
            <>
              <a href={url} target="_blank" rel="noopener noreferrer" title="在新标签页打开" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[12.5px] text-ink-2 hover:text-ink">
                <ExternalLink size={13} /> 打开
              </a>
              <a href={url} download={name.split("/").pop()} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[12.5px] text-ink-2 hover:text-ink">
                <Download size={13} /> 下载
              </a>
            </>
          )}
          <button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-raise hover:text-ink" title="关闭 (Esc)">
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          {isDir && state !== "missing" && (
            <aside className="w-[260px] shrink-0 overflow-auto border-r border-line bg-panel py-2">
              {tree ? <DirTree files={tree.files} active={sub} onPick={setSub} /> : <div className="px-4 py-3 text-ink-3">读取目录…</div>}
              {tree?.truncated && <div className="px-4 py-2 text-[11px] text-warn">文件太多，只显示前 5000 个</div>}
            </aside>
          )}
          <div className="min-w-0 flex-1 overflow-auto">
            {state === "missing" ? (
              <Notice title="文件已丢失">原路径上已经没有这个{isDir ? "目录" : "文件"}，可能被删除或移动了。附件只记录路径，不保存副本。</Notice>
            ) : url ? (
              <FileView key={url} url={url} name={name} size={size} />
            ) : (
              <Notice title={tree ? "目录为空" : "…"} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 p-10 text-center">
      <div className="font-display text-[30px] italic text-ink-3">{title}</div>
      {children && <p className="max-w-md text-ink-3">{children}</p>}
    </div>
  );
}

function FileView({ url, name, size }: { url: string; name: string; size: number }) {
  const kind = previewKind(name);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tooBig = (kind === "text" || kind === "markdown") && size > MAX_TEXT;

  useEffect(() => {
    if ((kind !== "text" && kind !== "markdown") || tooBig) return;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : r.json().then((j) => Promise.reject(j?.error?.message ?? `HTTP ${r.status}`))))
      .then(setText, (e) => setErr(String(e)));
  }, [url, kind, tooBig]);

  if (err) return <Notice title="读取失败">{err}</Notice>;
  if (kind === "image") {
    return (
      <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--raise)_0_25%,transparent_0_50%)] bg-[length:18px_18px] p-6">
        <img src={url} alt={name} className="max-h-[calc(100vh-180px)] max-w-full rounded shadow-[var(--shadow)]" />
      </div>
    );
  }
  if (kind === "pdf") return <iframe src={url} title={name} className="h-full min-h-[600px] w-full border-0" />;
  if (kind === "other") return <Notice title="无法预览">这种文件类型不能在页面里预览，可以下载后打开。</Notice>;
  if (tooBig) return <Notice title="文件太大">超过 2 MB 的文本不在页面里预览，可以下载后查看。</Notice>;
  if (text === null) return <div className="p-6 text-ink-3">读取中…</div>;
  if (kind === "markdown") {
    return (
      <div className="px-10 py-8">
        <Suspense fallback={<div className="text-ink-3">渲染中…</div>}>
          <Markdown text={text} />
        </Suspense>
      </div>
    );
  }
  return <CodeView text={text} />;
}

function CodeView({ text }: { text: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <div className="flex min-w-max font-mono text-[12.5px] leading-[1.65]">
      <pre className="sticky left-0 select-none border-r border-line bg-panel px-3 py-4 text-right text-ink-3">
        {lines.map((_, i) => `${i + 1}\n`)}
      </pre>
      <pre className="px-4 py-4 whitespace-pre text-ink">{text}</pre>
    </div>
  );
}

interface Node {
  name: string;
  path: string;
  children: Node[];
  size?: number;
}

function buildTree(files: { path: string; size: number }[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const f of files) {
    let node = root;
    const parts = f.path.split("/");
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.path === path);
      if (!child) {
        child = { name: part, path, children: [], size: i === parts.length - 1 ? f.size : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(!a.children.length) - Number(!b.children.length) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function DirTree({ files, active, onPick }: { files: { path: string; size: number }[]; active: string | null; onPick: (p: string) => void }) {
  const nodes = useMemo(() => buildTree(files), [files]);
  return <div className="text-[12.5px]">{nodes.map((n) => <TreeNode key={n.path} node={n} depth={0} active={active} onPick={onPick} />)}</div>;
}

function TreeNode({ node, depth, active, onPick }: { node: Node; depth: number; active: string | null; onPick: (p: string) => void }) {
  const isDir = node.children.length > 0;
  const [open, setOpen] = useState(depth < 1 || !!active?.startsWith(node.path + "/"));
  const pad = { paddingLeft: 10 + depth * 14 };
  if (!isDir) {
    return (
      <button
        type="button"
        onClick={() => onPick(node.path)}
        style={pad}
        className={cx("flex h-7 w-full items-center gap-1.5 pr-3 text-left", active === node.path ? "bg-accent-soft text-ink" : "text-ink-2 hover:bg-raise")}
      >
        <span className="w-3" />
        <span className="shrink-0 text-ink-3"><KindIcon name={node.name} size={12} /></span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="font-mono text-[10px] text-ink-3">{fmtSize(node.size ?? 0)}</span>
      </button>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} style={pad} className="flex h-7 w-full items-center gap-1.5 pr-3 text-left text-ink-2 hover:bg-raise">
        <ChevronRight size={12} className={cx("shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-ink-3">{open ? <FolderOpen size={12} /> : <Folder size={12} />}</span>
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} active={active} onPick={onPick} />)}
    </>
  );
}
