import { formatMeetingMinutes } from "./meetingMinutesFormat";
import type { SpeakerNames } from "./meetingSpeakerNames";

function escapeText(text: string) {
  return text.replace(/\u00a0/g, " ").replace(/[\\`*_{}\[\]<>|#!]/g, "\\$&");
}

/** Preserve identity only on marked occurrences, never reverse-replace a name
 * in unrelated prose. Editing an occurrence by hand makes it ordinary text. */
export function editableMinutesHtml(source: string, names: SpeakerNames): string {
  const html = formatMeetingMinutes(source, undefined, { email: false }).html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const text of textNodes) {
    const value = text.textContent ?? "";
    const matches = [...value.matchAll(/说话人[ \t]*([1-9]\d{0,2})(?!\d)/g)];
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(value.slice(offset, match.index));
      const span = doc.createElement("span");
      span.dataset.meetingSpeaker = match[1];
      span.dataset.speakerLabel = match[0];
      span.dataset.speakerDisplay = names[match[1]] || match[0];
      span.textContent = span.dataset.speakerDisplay;
      fragment.append(span);
      offset = match.index! + match[0].length;
    }
    fragment.append(value.slice(offset));
    text.replaceWith(fragment);
  }
  return doc.body.firstElementChild?.innerHTML ?? "";
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
  if (!(node instanceof Element)) return "";
  if (/^(SCRIPT|STYLE|IMG|IFRAME|OBJECT|INPUT|SVG|MATH)$/.test(node.tagName)) return "";
  if (node instanceof HTMLElement && node.dataset.meetingSpeaker &&
      /^[1-9]\d{0,2}$/.test(node.dataset.meetingSpeaker) && node.textContent === node.dataset.speakerDisplay) {
    return node.dataset.speakerLabel ?? `说话人${node.dataset.meetingSpeaker}`;
  }
  if (node.tagName === "BR") return "  \n";
  const content = Array.from(node.childNodes, inline).join("");
  if (/^(B|STRONG)$/.test(node.tagName)) return `**${content}**`;
  if (/^(I|EM)$/.test(node.tagName)) return `*${content}*`;
  if (/^(DEL|S|STRIKE)$/.test(node.tagName)) return `~~${content}~~`;
  if (node.tagName === "CODE") return "`" + (node.textContent ?? "").replace(/`/g, "\\`") + "`";
  if (/^(DIV|P)$/.test(node.tagName)) return content + "\n\n";
  return content;
}

function blocks(node: Node): string {
  if (!(node instanceof Element)) return inline(node);
  const children = () => Array.from(node.childNodes, blocks).join("");
  const tag = node.tagName;
  if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${Array.from(node.childNodes, inline).join("").trim()}\n\n`;
  if (tag === "TABLE") {
    const rows = Array.from(node.querySelectorAll("tr"), row => Array.from(row.children,
      cell => Array.from(cell.childNodes, inline).join("").trim().replace(/\s*\n\s*/g, " ")));
    if (!rows.length) return "";
    const count = Math.max(...rows.map(row => row.length));
    const render = (row: string[]) => `| ${Array.from({length:count},(_,i)=>row[i]??"").join(" | ")} |\n`;
    return render(rows[0]) + render(Array(count).fill("---")) + rows.slice(1).map(render).join("") + "\n";
  }
  if (tag === "UL" || tag === "OL") {
    const start = Number(node.getAttribute("start")) || 1;
    return Array.from(node.children).filter(child => child.tagName === "LI").map((li,index) => {
      const content = Array.from(li.childNodes, child => child instanceof Element && /^(UL|OL)$/.test(child.tagName)
        ? "\n" + blocks(child).trimEnd().split("\n").map(line=>"  "+line).join("\n")
        : inline(child)).join("").trim();
      return `${tag === "OL" ? `${index+start}.` : "-"} ${content}\n`;
    }).join("") + "\n";
  }
  if (tag === "BLOCKQUOTE") return children().trim().split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
  if (tag === "PRE") return "```\n" + (node.textContent ?? "") + "\n```\n\n";
  if (tag === "HR") return "---\n\n";
  if (tag === "P" || tag === "DIV") return children().trimEnd() + "\n\n";
  if (/^(SCRIPT|STYLE|IMG|IFRAME|OBJECT|INPUT|SVG|MATH)$/.test(tag)) return "";
  if (/^(STRONG|B|EM|I|DEL|S|STRIKE|CODE|SPAN|A|BR)$/.test(tag)) return inline(node);
  return children();
}

export function minutesElementToMarkdown(element: Element): string {
  return Array.from(element.childNodes, blocks).join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function pastedMinutesHtml(html: string, text: string): string {
  if (!html) return editableMinutesHtml(escapeText(text).replace(/\n/g, "  \n"), {});
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Pasted identity attributes are untrusted and must not claim provenance.
  doc.querySelectorAll("[data-meeting-speaker]").forEach(element => {
    element.removeAttribute("data-meeting-speaker");
  });
  return editableMinutesHtml(minutesElementToMarkdown(doc.body), {});
}
