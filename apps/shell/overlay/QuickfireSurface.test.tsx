// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuickfireSurfaceProps } from "./quickfireSurfaceModel";
import { QuickfireSurface } from "./QuickfireSurface";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const baseProps: QuickfireSurfaceProps = {
  mode: "quickfire",
  inputValue: "",
  inputEpoch: 1,
  placeholder: "Ask about this panel…",
  ghostSuffix: null,
  groups: [],
  selectedId: null,
  argSession: null,
  context: { title: "Task board" },
  emptyMessage: null,
  flashRowId: null,
  compose: {
    panelTitle: "Task board",
    hint: "Ask about this panel",
    transcriptOrder: "newest-first",
    disabledReason: null,
    transcript: [],
    olderCount: 0,
    credentialRequest: null,
    resume: null,
    connecting: false,
    streaming: true,
    promoted: false,
    hasConversation: true,
    error: null,
  },
};

describe("QuickfireSurface activity", () => {
  it("emits clear on the first click without an armed confirmation state", () => {
    const emitIntent = vi.fn();
    render(<QuickfireSurface props={baseProps} emitIntent={emitIntent} />);

    fireEvent.click(screen.getByRole("button", { name: "⟲ Clear" }));

    expect(emitIntent).toHaveBeenCalledWith({ type: "clear" });
  });

  it("renders the live phase, spinner, and tool progress", () => {
    render(
      <QuickfireSurface
        props={{
          ...baseProps,
          compose: {
            ...baseProps.compose!,
            transcript: [
              {
                kind: "activity",
                id: "activity:turn-1",
                state: "working",
                phase: "using-tools",
                label: "Using tools…",
                toolCalls: [
                  { id: "call-1", name: "panel_describe", state: "done" },
                  { id: "call-2", name: "panel_screenshot", state: "running" },
                ],
              },
            ],
          },
        }}
        emitIntent={vi.fn()}
      />,
    );

    expect(screen.queryByText("Agent active")).toBeNull();
    expect(screen.getByText("Using tools…")).toBeTruthy();
    const summaries = [...document.querySelectorAll(".quickfire-record > summary")].map(
      (summary) => summary.textContent,
    );
    expect(summaries).toEqual(expect.arrayContaining([
      expect.stringContaining("panel_describe"),
      expect.stringContaining("panel_screenshot"),
    ]));
    expect(document.querySelector(".quickfire-spinner")).not.toBeNull();
  });

  it("shows a spinner while the conversation itself is connecting", () => {
    render(
      <QuickfireSurface
        props={{
          ...baseProps,
          compose: {
            ...baseProps.compose!,
            connecting: true,
            streaming: false,
          },
        }}
        emitIntent={vi.fn()}
      />,
    );

    expect(screen.getByText(/Starting a conversation/u)).toBeTruthy();
    expect(document.querySelector(".quickfire-spinner")).not.toBeNull();
  });

  it("renders Markdown and expandable thinking and tool details", () => {
    render(
      <QuickfireSurface
        props={{
          ...baseProps,
          compose: {
            ...baseProps.compose!,
            transcript: [
              {
                kind: "thinking",
                id: "thinking-1",
                title: "Inspecting live state",
                text: "Inspecting **live state**",
              },
              {
                kind: "message",
                id: "message-1",
                author: "agent",
                authorLabel: "agent",
                text: "Found `channel-1`.",
                toolCalls: [
                  {
                    id: "call-1",
                    name: "panel_eval",
                    state: "failed",
                    input: '{\n  "expression": "window.location.href"\n}',
                    failure: "Panel was unavailable",
                  },
                ],
              },
            ],
          },
        }}
        emitIntent={vi.fn()}
      />,
    );

    expect(screen.getByText("live state").tagName).toBe("STRONG");
    expect(screen.getByText("Inspecting live state")).toBeTruthy();
    expect(screen.getByText("channel-1").tagName).toBe("CODE");
    fireEvent.click(screen.getByText(/panel_eval/u));
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Panel was unavailable")).toBeTruthy();
  });
});
