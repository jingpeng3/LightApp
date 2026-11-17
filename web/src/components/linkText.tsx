// 匹配 http(s) 链接，遇到空白、引号、尖括号或常见中文标点就结束
const URL_RE = /https?:\/\/[^\s<>"'`）】，。；：、！》」』]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

/** 把纯文本里的 http(s) 链接渲染成可点击的链接，统一在新标签页打开；terms 里的词高亮。 */
export function LinkText({ text, terms }: { text: string; terms?: string[] }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING, "");
    const start = m.index!;
    if (start > last) parts.push(<Highlight key={`t${last}`} text={text.slice(last, start)} terms={terms} />);
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
        <Highlight text={url} terms={terms} />
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(<Highlight key={`t${last}`} text={text.slice(last)} terms={terms} />);
  return <>{parts}</>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 搜索词在文字里出现的地方加底色，不区分大小写。 */
export function Highlight({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escape).join("|")})`, "gi");
  const lower = terms.map((t) => t.toLowerCase());
  return (
    <>
      {text.split(re).map((part, i) =>
        lower.includes(part.toLowerCase()) ? <mark key={i} className="rounded-[2px] bg-accent-soft text-inherit ring-1 ring-accent/40">{part}</mark> : part,
      )}
    </>
  );
}

export const hits = (text: string, terms?: string[]) => !!terms?.some((t) => text.toLowerCase().includes(t.toLowerCase()));
