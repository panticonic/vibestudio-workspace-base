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
import Bookmarks from "../../about/bookmarks/index";
import History from "../../about/history/index";
import Downloads from "../../about/downloads/index";

const browserData = vi.hoisted(() => ({
  searchBookmarks: vi.fn(),
  updateBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  getHistory: vi.fn(),
  deleteHistoryEntry: vi.fn(),
  clearAllHistory: vi.fn(),
  deleteHistoryRange: vi.fn(),
  listDownloads: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  cancelDownload: vi.fn(),
  openDownload: vi.fn(),
  revealDownload: vi.fn(),
}));
vi.mock("@workspace/runtime", () => ({ browserData, openPanel: vi.fn() }));
vi.mock("./ui", () => ({
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
const bookmark = {
  id: 1,
  title: "Example",
  url: "https://example.com",
  folder_path: "",
};
const history = {
  id: 1,
  title: "Example",
  url: "https://example.com",
  last_visit: 100,
};
const download = {
  id: "one",
  filename: "report.pdf",
  url: "https://example.com/report.pdf",
  state: "completed",
  receivedBytes: 2048,
  totalBytes: 2048,
};

beforeEach(() => {
  vi.resetAllMocks();
  browserData.searchBookmarks.mockResolvedValue([bookmark]);
  browserData.getHistory.mockResolvedValue([history]);
  browserData.listDownloads.mockResolvedValue([download]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("browser management panels", () => {
  it("edits bookmarks in an accessible dialog and retains input after a failed save", async () => {
    browserData.updateBookmark
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValueOnce(undefined);
    render(<Bookmarks />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Edit bookmark" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), {
      target: { value: "New title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Save failed",
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveProperty(
      "value",
      "New title",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(browserData.updateBookmark).toHaveBeenLastCalledWith(1, {
      title: "New title",
    });
  });

  it("reports failed removal without hiding the bookmark", async () => {
    browserData.deleteBookmark.mockRejectedValue(
      new Error("Cannot remove bookmark"),
    );
    render(<Bookmarks />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Cannot remove bookmark",
    );
    expect(screen.getByRole("heading", { name: "Example" })).toBeTruthy();
  });

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
    await act(async () => {
      resolveOld([{ ...history, title: "old" }]);
    });
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

  it("shows download action failures and does not erase them on a successful refresh", async () => {
    vi.useFakeTimers();
    browserData.openDownload.mockRejectedValue(
      new Error("File no longer exists"),
    );
    render(<Downloads />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveProperty(
      "textContent",
      "File no longer exists",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("alert")).toHaveProperty(
      "textContent",
      "File no longer exists",
    );
  });

  it("waits for download reads to settle before polling and stops polling on unmount", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: (typeof download)[]) => void;
    browserData.listDownloads.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { unmount } = render(<Downloads />);
    expect(screen.getByRole("status").textContent).toContain(
      "Loading downloads",
    );
    expect(screen.queryByText("No browser downloads yet.")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(browserData.listDownloads).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      resolve([]);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(browserData.listDownloads).toHaveBeenCalledOnce();
  });
});
