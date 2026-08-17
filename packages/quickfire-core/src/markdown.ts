/** A small, platform-neutral Markdown tree for compact native surfaces. */
export type QuickfireMarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: QuickfireMarkdownInline[] }
  | { kind: "emphasis"; children: QuickfireMarkdownInline[] }
  | { kind: "link"; href: string; children: QuickfireMarkdownInline[] };

export type QuickfireMarkdownBlock =
  | { kind: "paragraph"; children: QuickfireMarkdownInline[] }
  | { kind: "heading"; level: number; children: QuickfireMarkdownInline[] }
  | { kind: "bullet-list"; items: QuickfireMarkdownInline[][] }
  | { kind: "ordered-list"; items: QuickfireMarkdownInline[][] }
  | { kind: "quote"; children: QuickfireMarkdownInline[] }
  | { kind: "code-block"; text: string; language?: string };

const FENCE = /^\s*```([\w+-]*)\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.+)$/;
const BULLET = /^\s*[-*]\s+(.+)$/;
const ORDERED = /^\s*\d+[.)]\s+(.+)$/;
const QUOTE = /^\s*>\s?(.*)$/;

export function parseQuickfireMarkdown(
  source: string,
): QuickfireMarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: QuickfireMarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code-block",
        text: code.join("\n"),
        ...(fence[1] ? { language: fence[1] } : {}),
      });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]?.length ?? 1,
        children: parseQuickfireMarkdownInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet) {
      const items: QuickfireMarkdownInline[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(BULLET);
        if (!match) break;
        items.push(parseQuickfireMarkdownInline(match[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "bullet-list", items });
      continue;
    }
    const ordered = line.match(ORDERED);
    if (ordered) {
      const items: QuickfireMarkdownInline[][] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(ORDERED);
        if (!match) break;
        items.push(parseQuickfireMarkdownInline(match[1] ?? ""));
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }
    const quote = line.match(QUOTE);
    if (quote) {
      const text: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(QUOTE);
        if (!match) break;
        text.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({
        kind: "quote",
        children: parseQuickfireMarkdownInline(text.join(" ")),
      });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        !current.trim() ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current) ||
        QUOTE.test(current)
      )
        break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({
      kind: "paragraph",
      children: parseQuickfireMarkdownInline(paragraph.join(" ")),
    });
  }
  return blocks;
}

export function parseQuickfireMarkdownInline(
  source: string,
): QuickfireMarkdownInline[] {
  return parseInline(source, 0);
}

function parseInline(source: string, depth: number): QuickfireMarkdownInline[] {
  if (depth > 8 || !source)
    return source ? [{ kind: "text", text: source }] : [];
  const nodes: QuickfireMarkdownInline[] = [];
  const marker = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(marker)) {
    const at = match.index ?? 0;
    if (at > cursor)
      nodes.push({ kind: "text", text: source.slice(cursor, at) });
    const token = match[0];
    if (token.startsWith("`"))
      nodes.push({ kind: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) {
      nodes.push({
        kind: "strong",
        children: parseInline(token.slice(2, -2), depth + 1),
      });
    } else if (token.startsWith("*")) {
      nodes.push({
        kind: "emphasis",
        children: parseInline(token.slice(1, -1), depth + 1),
      });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
      if (link) {
        const href = link[2] ?? "";
        nodes.push(
          /^(?:https?:|mailto:)/iu.test(href)
            ? {
                kind: "link",
                href,
                children: parseInline(link[1] ?? "", depth + 1),
              }
            : { kind: "text", text: link[1] ?? "" },
        );
      }
    }
    cursor = at + token.length;
  }
  if (cursor < source.length)
    nodes.push({ kind: "text", text: source.slice(cursor) });
  return nodes;
}
