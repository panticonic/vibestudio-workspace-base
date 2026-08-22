// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";

const select = vi.fn(async () => undefined);

vi.mock("../shell/client", () => ({
  app: {
    getInfo: vi.fn(async () => ({ connectionMode: "remote" })),
  },
  workspace: {
    list: vi.fn(async () => [
      { name: "current", path: "/remote/current", lastOpened: 2 },
      { name: "shared", path: "/remote/shared", lastOpened: 1 },
    ]),
    getActive: vi.fn(async () => "current"),
    select,
    delete: vi.fn(),
  },
}));
vi.mock("./HostTargetsSection", () => ({ HostTargetsSection: () => null }));
vi.mock("./TemplatesSection", () => ({ TemplatesSection: () => null }));

const { WorkspaceChooser } = await import("./WorkspaceChooser");

describe("WorkspaceChooser remote sessions", () => {
  it("switches through the retained hub pairing instead of asking the device to pair again", async () => {
    render(
      <Provider>
        <Theme>
          <WorkspaceChooser />
        </Theme>
      </Provider>,
    );

    const target = await screen.findByRole("button", { name: /shared/i });
    expect((target as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(target);

    await waitFor(() => expect(select).toHaveBeenCalledWith("shared"));
    expect(screen.getByText(/without pairing again/i)).toBeTruthy();
  });
});
