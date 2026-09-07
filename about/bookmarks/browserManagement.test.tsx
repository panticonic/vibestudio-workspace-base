// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Bookmarks from "./index";

const browserData = vi.hoisted(() => ({
  searchBookmarks: vi.fn(),
  updateBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
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

const bookmark = {
  id: 1,
  title: "Example",
  url: "https://example.com",
  folder_path: "",
};

beforeEach(() => {
  vi.resetAllMocks();
  browserData.searchBookmarks.mockResolvedValue([bookmark]);
});
afterEach(cleanup);

describe("bookmarks management", () => {
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
});
