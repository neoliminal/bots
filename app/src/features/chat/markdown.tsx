// Minimal, safe Markdown renderer for bot messages.
// Supports: paragraphs, **bold**, *italic* / _italic_, `code`, ``` fences,
// [links](https://…) (http/https only), and -/*/1. lists.
// Everything is emitted as React elements — raw HTML in the input stays text.

import type { ReactNode } from "react";

const INLINE_TOKEN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/;

const SAFE_URL = /^https?:\/\//i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length > 0) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}.${k++}`;
    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/15">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (match[3] || match[4]) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link && SAFE_URL.test(link[2])) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#007aff] underline decoration-[#007aff]/40 underline-offset-2 hover:decoration-[#007aff] dark:text-[#409cff] dark:decoration-[#409cff]/40 dark:hover:decoration-[#409cff]"
          >
            {renderInline(link[1], key)}
          </a>,
        );
      } else {
        // Unsafe or malformed link — keep the literal text.
        nodes.push(token);
      }
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

function renderParagraphLines(lines: string[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${keyPrefix}.br${i}`} />);
    nodes.push(...renderInline(line, `${keyPrefix}.l${i}`));
  });
  return nodes;
}

const FENCE = /^\s*```/;
const UL_ITEM = /^\s*[-*]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;

export function renderMarkdown(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or run past the end)
      blocks.push(
        <pre
          key={`b${b++}`}
          className="overflow-x-auto rounded-md bg-black/10 p-2 font-mono text-[0.85em] dark:bg-white/15"
        >
          <code>{code.join("\n")}</code>
        </pre>,
      );
    } else if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const itemRe = ordered ? OL_ITEM : UL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const m = itemRe.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const key = `b${b++}`;
      const children = items.map((item, j) => (
        <li key={`${key}.${j}`}>{renderInline(item, `${key}.${j}`)}</li>
      ));
      blocks.push(
        ordered ? (
          <ol key={key} className="list-decimal pl-5">
            {children}
          </ol>
        ) : (
          <ul key={key} className="list-disc pl-5">
            {children}
          </ul>
        ),
      );
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !FENCE.test(lines[i]) &&
        !UL_ITEM.test(lines[i]) &&
        !OL_ITEM.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      const key = `b${b++}`;
      blocks.push(<p key={key}>{renderParagraphLines(para, key)}</p>);
    }
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2 break-words">{renderMarkdown(text)}</div>;
}
