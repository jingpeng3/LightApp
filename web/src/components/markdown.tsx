import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 预览里的链接统一在新标签页打开，不在当前页跳走丢掉应用状态
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-dt">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
