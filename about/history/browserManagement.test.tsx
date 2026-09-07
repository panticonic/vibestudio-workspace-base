// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import History from "./index";

const browserData = vi.hoisted(() => ({
  getHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  clearAllHistory: vi.fn(),
  deleteHistoryRange: vi.fn(),
}));
vi.mock("@workspace/runtime", () => ({ browserData, openPanel: vi.fn() }));
vi.mock("../../packages/about-shared/ui", () => ({
  AboutThemeRoot: ({ children }: { children: ReactNode }) => (
    <Theme>{children}</Theme>
  ),
  AboutPage: ({
    children,
    actions,
  }: {
    children: ReactNode;
    actions: ReactNode;
  }) => (
    <main>
      {actions}
      {children}
    </main>
  ),
  Section: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
}));

const history = {
  id: 1,
  title: "Example",
  url: "https://example.com",
  last_visit: 100,
};

beforeEach(() => {
  vi.resetAllMocks();
  browserData.getHistory.mockResolvedValue([history]);
});
afterEach(cleanup);

describe("history management", () => {
  it("keeps the latest history search when an older request finishes later", async () => {
    let resolveOld!: (rows: (typeof history)[]) => void;
    browserData.getHistory.mockImplementation(
      ({ search }: { search?: string }) =>
        search === "old"
          ? new Promise((resolve) => {
              resolveOld = resolve;
            })
          : Promise.resolve([{ ...history, title: search ?? "Example" }]),
    );
    render(<History />);
    await screen.findByRole("heading", { name: "Example" });
    const input = screen.getByRole("textbox", { name: "Search history" });
    fireEvent.change(input, { target: { value: "old" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("heading", { name: "new" });
    await act(async () => resolveOld([{ ...history, title: "old" }]));
    expect(screen.queryByRole("heading", { name: "old" })).toBeNull();
    expect(screen.getByRole("heading", { name: "new" })).toBeTruthy();
  });

  it("requires in-panel confirmation and keeps a failed clear operation retryable", async () => {
    browserData.deleteHistoryRange
      .mockRejectedValueOnce(new Error("Clear failed"))
      .mockResolvedValueOnce(undefined);
    render(<History />);
    await screen.findByRole("heading", { name: "Example" });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(browserData.deleteHistoryRange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Clear failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const [start, end] = browserData.deleteHistoryRange.mock.lastCall!;
    expect(end - start).toBe(24 * 60 * 60 * 1000);
  });
});
