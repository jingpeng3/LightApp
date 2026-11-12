// 匹配 http(s) 链接，遇到空白、引号、尖括号或常见中文标点就结束
const URL_RE = /https?:\/\/[^\s<>"'`）】，。；：、！》」』]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

/** 把纯文本里的 http(s) 链接渲染成可点击的链接，统一在新标签页打开。 */
export function LinkText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING, "");
    const start = m.index!;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        onClick={(e) => e.stopPropagation()}
        className="text-accent hover:underline"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
