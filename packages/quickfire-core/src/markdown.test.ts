import { describe, expect, it } from "vitest";
import { parseQuickfireMarkdown } from "./markdown";

describe("quickfire Markdown", () => {
  it("projects common block and inline structure for both renderers", () => {
    expect(
      parseQuickfireMarkdown(
        "## Result\n\n- **ready**\n- use `panel_eval`\n\n> live state\n\n```ts\nconst ok = true;\n```",
      ),
    ).toEqual([
      expect.objectContaining({ kind: "heading", level: 2 }),
      expect.objectContaining({ kind: "bullet-list" }),
      expect.objectContaining({ kind: "quote" }),
      { kind: "code-block", language: "ts", text: "const ok = true;" },
    ]);
  });

  it("turns only safe external destinations into links", () => {
    expect(
      parseQuickfireMarkdown("[docs](https://example.com)")[0],
    ).toMatchObject({
      children: [
        expect.objectContaining({ kind: "link", href: "https://example.com" }),
      ],
    });
    expect(
      parseQuickfireMarkdown("[do not run](javascript:evil)")[0],
    ).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ kind: "text" }),
      ]),
    });
  });
});
