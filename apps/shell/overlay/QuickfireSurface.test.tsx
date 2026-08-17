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
    expandable: false,
    credentialRequest: null,
    resume: null,
    connecting: false,
    streaming: true,
    promoted: false,
    hasConversation: true,
    error: null,
  },
};

function renderSurface(
  compose: Partial<NonNullable<QuickfireSurfaceProps["compose"]>> = {},
  emitIntent = vi.fn(),
) {
  render(
    <QuickfireSurface
      props={{ ...baseProps, compose: { ...baseProps.compose!, ...compose } }}
      emitIntent={emitIntent}
    />,
  );
  return emitIntent;
}

describe("QuickfireSurface conversation", () => {
  it("emits clear on the first click without an armed confirmation state", () => {
    const emitIntent = renderSurface();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear this conversation and start a new one" }),
    );

    expect(emitIntent).toHaveBeenCalledWith({ type: "clear" });
  });

  it("renders the live phase, spinner, and each tool call's own state", () => {
    renderSurface({
      transcript: [
        {
          kind: "activity",
          id: "activity:turn-1",
          state: "working",
          phase: "using-tools",
          label: "using tools",
          toolCalls: [
            { id: "call-1", name: "panel_describe", state: "done", durationMs: 1_240 },
            { id: "call-2", name: "panel_screenshot", state: "running" },
          ],
        },
      ],
    });

    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("using tools")).toBeTruthy();
    expect(screen.getByText("panel_describe")).toBeTruthy();
    // Duration and liveness distinguish the two calls; a name-only chip did not.
    expect(screen.getByText("1.2s")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(document.querySelector(".qf-spinner")).not.toBeNull();
  });

  it("shows a spinner while the conversation itself is connecting", () => {
    renderSurface({ connecting: true, streaming: false });

    expect(screen.getByText(/Starting a conversation/u)).toBeTruthy();
    expect(document.querySelector(".qf-spinner")).not.toBeNull();
  });

  it("renders Markdown structure the old projection dropped", () => {
    renderSurface({
      transcript: [
        {
          kind: "message",
          id: "message-1",
          author: "agent",
          authorLabel: "agent",
          text: [
            "Found `channel-1` with **live state**.",
            "",
            "| Panel | State |",
            "| --- | --- |",
            "| Chat | open |",
            "",
            "- [x] checked the console",
            "- [ ] reproduced it",
          ].join("\n"),
        },
      ],
    });

    expect(screen.getByText("live state").tagName).toBe("SPAN");
    expect(screen.getByText("live state").dataset["variant"]).toBe("strong");
    expect(screen.getByText("channel-1").tagName).toBe("CODE");
    expect(screen.getByTestId("quickfire-table")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("☑")).toBeTruthy();
    expect(screen.getByText("☐")).toBeTruthy();
  });

  it("keeps a failed turn's reason reachable instead of only colouring it", () => {
    renderSurface({
      transcript: [
        {
          kind: "message",
          id: "message-1",
          author: "agent",
          authorLabel: "agent",
          text: "",
          error: true,
          errorText: "provider returned 503",
        },
      ],
    });

    expect(screen.getByText("failed")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("What went wrong"));
    expect(screen.getByText("provider returned 503")).toBeTruthy();
  });

  it("expands a tool call to its input, output and failure", () => {
    renderSurface({
      transcript: [
        {
          kind: "message",
          id: "message-1",
          author: "agent",
          authorLabel: "agent",
          text: "Tried to read the page.",
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
    });

    fireEvent.click(screen.getByLabelText("panel_eval — failed"));
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Panel was unavailable")).toBeTruthy();
  });

  it("announces a card it cannot run, and offers the surface that can", () => {
    const emitIntent = renderSurface({
      transcript: [{ kind: "rich", id: "rich-1", title: "Card · chart", detail: "Q3 revenue" }],
    });

    expect(screen.getByText("Card · chart")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open it in the chat panel" }));
    expect(emitIntent).toHaveBeenCalledWith({ type: "promote" });
  });

  it("offers to pull in trimmed entries rather than only counting them", () => {
    const emitIntent = renderSurface({
      olderCount: 12,
      expandable: true,
      transcript: [
        { kind: "message", id: "m", author: "you", authorLabel: "you", text: "hello" },
      ],
    });

    expect(screen.getByText("12 earlier entries")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show earlier entries in this conversation" }),
    );
    expect(emitIntent).toHaveBeenCalledWith({ type: "show-older" });
  });

  it("puts a stop control next to the input while a turn is in flight", () => {
    const emitIntent = renderSurface({ streaming: true });

    fireEvent.click(screen.getByRole("button", { name: "Stop the turn in flight" }));
    expect(emitIntent).toHaveBeenCalledWith({ type: "stop" });
  });
});

describe("QuickfireSurface screenshots and actions", () => {
  const screenshotCall = {
    id: "call-1",
    name: "panel_screenshot",
    state: "done" as const,
    images: [{ id: "call-1:0", mimeType: "image/png", width: 1280, height: 800, bytes: 402_931 }],
  };

  it("offers a screenshot's bytes rather than shipping them on every push", () => {
    const emitIntent = renderSurface({
      transcript: [
        {
          kind: "message",
          id: "m1",
          author: "agent",
          authorLabel: "agent",
          text: "Here is the panel.",
          toolCalls: [screenshotCall],
        },
      ],
    });

    fireEvent.click(screen.getByLabelText("panel_screenshot — done"));
    fireEvent.click(
      screen.getByRole("button", { name: "Show Image from panel_screenshot, 1280×800 · 393 KB" }),
    );
    expect(emitIntent).toHaveBeenCalledWith({ type: "reveal-image", imageId: "call-1:0" });
  });

  it("draws the screenshot once the chrome has carried it over", () => {
    renderSurface({
      transcript: [
        {
          kind: "message",
          id: "m1",
          author: "agent",
          authorLabel: "agent",
          text: "Here is the panel.",
          toolCalls: [
            {
              ...screenshotCall,
              images: [{ ...screenshotCall.images[0]!, dataUrl: "data:image/png;base64,aGk=" }],
            },
          ],
        },
      ],
    });

    fireEvent.click(screen.getByLabelText("panel_screenshot — done"));
    const image = screen.getByAltText("Image from panel_screenshot");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,aGk=");
  });

  it("recalls your last message into an empty compose", () => {
    const emitIntent = renderSurface({
      transcript: [{ kind: "message", id: "m1", author: "you", authorLabel: "you", text: "hello" }],
    });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    expect(emitIntent).toHaveBeenCalledWith({ type: "recall", delta: -1 });
  });

  it("lets you re-aim the overlay at another panel from the context strip", () => {
    const emitIntent = renderSurface();

    fireEvent.click(screen.getByRole("button", { name: "Choose which panel this acts on" }));
    expect(emitIntent).toHaveBeenCalledWith({ type: "retarget" });
  });

  it("offers panel-aware openers on an empty conversation", () => {
    const emitIntent = renderSurface({
      transcript: [],
      suggestions: [
        { id: "explain", label: "What is this panel doing?", prompt: "Describe this panel." },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Describe this panel." }));
    expect(emitIntent).toHaveBeenCalledWith({ type: "send", text: "Describe this panel." });
  });
});
