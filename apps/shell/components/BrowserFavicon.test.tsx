// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserFavicon } from "./BrowserFavicon";
const scope = vi.hoisted(() => ({
  current: {} as { browserData: { getPageFavicon: ReturnType<typeof vi.fn> } }
}));
vi.mock("../shell/workspaceContext", () => ({
  useShellWorkspaceClient: () => scope.current
}));
afterEach(cleanup);
it("does not reuse an identical handle or stale image across workspace clients", async () => {
  const personal = {
    browserData: {
      getPageFavicon: vi.fn(async () => ({
        mime_type: "image/png",
        image_data: "cGVyc29uYWw="
      }))
    }
  };
  let finish!: (value: null) => void;
  const project = {
    browserData: {
      getPageFavicon: vi.fn(
        () =>
          new Promise<null>((resolve) => {
            finish = resolve;
          })
      )
    }
  };
  const handle = { pageUrl: "https://example.test/private", updatedAt: 12 };
  scope.current = personal;
  const result = render(<BrowserFavicon handle={handle} />);
  await waitFor(() =>
    expect(result.container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,cGVyc29uYWw="
    )
  );
  scope.current = project;
  result.rerender(<BrowserFavicon handle={handle} />);
  expect(result.container.querySelector("img")).toBeNull();
  expect(project.browserData.getPageFavicon).toHaveBeenCalledWith(handle.pageUrl);
  await act(async () => finish(null));
  expect(result.container.querySelector("img")).toBeNull();
  scope.current = personal;
  result.rerender(<BrowserFavicon handle={handle} />);
  expect(result.container.querySelector("img")?.getAttribute("src")).toBe(
    "data:image/png;base64,cGVyc29uYWw="
  );
  expect(personal.browserData.getPageFavicon).toHaveBeenCalledTimes(1);
});
