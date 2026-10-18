import React from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
const components: Components = {
  img: ({ alt }) => <span>[圖片省略{alt ? `：${alt}` : ""}]</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children} ↗
    </a>
  ),
  pre: ({ children }) => <pre>{children}</pre>,
};
export function Message({
  children,
  truncated = false,
}: {
  children: string;
  truncated?: boolean;
}) {
  return (
    <>
      <ReactMarkdown skipHtml components={components}>
        {children}
      </ReactMarkdown>
      {truncated && (
        <small role="status">內容已截斷；可按需讀取較完整預覽。</small>
      )}
    </>
  );
}
export function textContent(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .map((part) => {
              if (!part || typeof part !== "object") return "";
              const p = part as Record<string, unknown>;
              return p.type === "text" && typeof p.text === "string"
                ? p.text
                : "";
            })
            .join("\n")
        : "";
  return text.length > 30000 ? `${text.slice(0, 30000)}\n\n[內容已截斷]` : text;
}
