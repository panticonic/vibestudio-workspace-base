// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Downloads from "./index";

const browserData = vi.hoisted(() => ({
  listDownloads: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  cancelDownload: vi.fn(),
  openDownload: vi.fn(),
  revealDownload: vi.fn(),
}));
vi.mock("@workspace/runtime", () => ({ browserData }));
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
}));

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
  browserData.listDownloads.mockResolvedValue([download]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("downloads management", () => {
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
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(screen.getByRole("alert")).toHaveProperty(
      "textContent",
      "File no longer exists",
    );
  });

  it("waits for download reads to settle before polling and stops polling on unmount", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: (typeof download)[]) => void;
    browserData.listDownloads.mockReturnValue(
      new Promise((done) => (resolve = done)),
    );
    const { unmount } = render(<Downloads />);
    expect(screen.getByRole("status").textContent).toContain(
      "Loading downloads",
    );
    expect(screen.queryByText("No browser downloads yet.")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(browserData.listDownloads).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      resolve([]);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(browserData.listDownloads).toHaveBeenCalledOnce();
  });
});
