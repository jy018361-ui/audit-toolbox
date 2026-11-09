import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const fontFamily = '"Microsoft YaHei", "微软雅黑", sans-serif';
const typography: CSSProperties = { fontFamily, color: "#000000", fontSize: "11pt", lineHeight: "1.75" };
const cell: CSSProperties = { ...typography, fontSize: "10.5pt", border: "1px solid #cfd7dc", padding: "9px 12px", textAlign: "left", verticalAlign: "top" };

/** Inline styles survive Outlook's Word HTML editor and formatted paste. */
function MinutesBody({ markdown }: { markdown: string }) {
  return <div style={{ ...typography, maxWidth: "800px", padding: "8px 8px 20px 0" }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      h1: ({ children }) => <h1 style={{ ...typography, fontSize: "20pt", fontWeight: 700, color: "#000000", margin: "0 0 22px", padding: "0 0 14px", borderBottom: "2px solid #d8e4e6", lineHeight: "1.4" }}>{children}</h1>,
      h2: ({ children }) => <h2 style={{ ...typography, fontSize: "13pt", fontWeight: 700, color: "#000000", margin: "24px 0 10px" }}>{children}</h2>,
      h3: ({ children }) => <h3 style={{ ...typography, fontSize: "11.5pt", fontWeight: 700, margin: "16px 0 8px" }}>{children}</h3>,
      h4: ({ children }) => <h4 style={{ ...typography, fontWeight: 700, margin: "14px 0 8px" }}>{children}</h4>,
      h5: ({ children }) => <h5 style={{ ...typography, fontWeight: 700 }}>{children}</h5>,
      h6: ({ children }) => <h6 style={{ ...typography, fontWeight: 700 }}>{children}</h6>,
      p: ({ children }) => <p style={{ ...typography, margin: "8px 0" }}>{children}</p>,
      ul: ({ children }) => <ul style={{ ...typography, margin: "8px 0", paddingLeft: "26px", listStyleType: "disc" }}>{children}</ul>,
      ol: ({ children, start }) => <ol start={start} style={{ ...typography, margin: "8px 0", paddingLeft: "26px", listStyleType: "decimal" }}>{children}</ol>,
      li: ({ children }) => <li style={{ ...typography, margin: "4px 0" }}>{children}</li>,
      blockquote: ({ children }) => <blockquote style={{ ...typography, margin: "12px 0", padding: "4px 14px", borderLeft: "3px solid #bacdd0", color: "#000000" }}>{children}</blockquote>,
      table: ({ children }) => <table cellPadding={0} cellSpacing={0} style={{ width: "100%", borderCollapse: "collapse", margin: "12px 0 18px", ...typography }}>{children}</table>,
      th: ({ children }) => <th style={{ ...cell, backgroundColor: "#f0f4f5", fontWeight: 700 }}>{children}</th>,
      td: ({ children }) => <td style={cell}>{children}</td>,
      pre: ({ children }) => <pre style={{ ...typography, whiteSpace: "pre-wrap", padding: "10px 12px", backgroundColor: "#f5f7f8" }}>{children}</pre>,
      code: ({ children }) => <code style={{ fontFamily, fontSize: "inherit" }}>{children}</code>,
      a: ({ children }) => <span>{children}</span>,
      img: () => null,
      input: () => null,
      hr: () => <hr style={{ border: 0, borderTop: "1px solid #d8e4e6", margin: "18px 0" }} />,
    }}>{markdown}</ReactMarkdown>
  </div>;
}

function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return Array.from(node.childNodes, textOf).join("");
  const tag = node.tagName;
  if (tag === "BR") return "\n";
  if (tag === "TR") return Array.from(node.children, textOf).map(value => value.trim()).join("\t") + "\n";
  const text = Array.from(node.childNodes, textOf).join("");
  if (tag === "LI") return `• ${text.trim()}\n`;
  return /^(P|H[1-6]|UL|OL|TABLE|PRE|BLOCKQUOTE|DIV)$/.test(tag) ? text.trim() + "\n\n" : text;
}

export function formatMeetingMinutes(markdown: string, fallbackTitle = "未命名会议", options: { email?: boolean } = { email: true }) {
  const displayMarkdown = options.email === false ? markdown : markdown.replace(/^(#[ \t]+[^\n]*?)[ \t]*[（(]按(?:内容|时间)[）)][ \t]*$/m, "$1");
  const fragment = renderToStaticMarkup(<MinutesBody markdown={displayMarkdown} />);
  const document = new DOMParser().parseFromString(fragment, "text/html");
  const topic = (document.querySelector("h1")?.textContent || fallbackTitle)
    .replace(/\s*[（(]按(?:内容|时间)[）)]\s*$/, "").replace(/[_\s]*会议纪要\s*$/, "").trim() || "未命名会议";
  const subject = `${topic}_会议纪要`.replace(/[\r\n\t]+/g, " ").slice(0, 255);
  const title = subject.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
  return {
    subject,
    html: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;padding:0;font-family:Microsoft YaHei,微软雅黑,sans-serif;background:#fff;color:#000000">${fragment}</body></html>`,
    text: textOf(document.body).trim(),
  };
}

/** Write both representations so Outlook/Word retain structure and plain
 * text targets still receive readable text without Markdown delimiters. */
export async function copyFormattedMinutes(formatted: { html: string; text: string }): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([formatted.html], { type: "text/html" }),
        "text/plain": new Blob([formatted.text], { type: "text/plain" }),
      })]);
      return true;
    } catch { /* Embedded browsers may instead permit a user-triggered copy event. */ }
  }
  let copied = false;
  const handler = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData("text/html", formatted.html);
    event.clipboardData.setData("text/plain", formatted.text);
    copied = true;
  };
  document.addEventListener("copy", handler);
  try {
    if (document.execCommand?.("copy") && copied) return true;
  } finally { document.removeEventListener("copy", handler); }
  await navigator.clipboard.writeText(formatted.text);
  return false;
}
