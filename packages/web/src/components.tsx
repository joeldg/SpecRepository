import { useMemo } from "react";
import { marked } from "marked";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace("_", " ")}</span>;
}

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => marked.parse(content, { async: false }) as string, [content]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="diff">
      {lines.map((line, i) => {
        let cls = "ctx";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index") || line.startsWith("=")) {
          cls = "meta";
        } else if (line.startsWith("@@")) {
          cls = "hunk";
        } else if (line.startsWith("+")) {
          cls = "add";
        } else if (line.startsWith("-")) {
          cls = "del";
        }
        return (
          <div key={i} className={`line ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
