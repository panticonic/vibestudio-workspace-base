// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateBrowser, TemplateWorkspaceReview } from "./TemplateBrowser";
const pin = {
  url: "git+https://example.test/garden.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
const inspection = {
  pin,
  presentation: { name: "Garden" },
  repositories: ["panels/garden"],
  files: [],
};
afterEach(cleanup);
it("captures the reviewed source and name once while creation is pending", async () => {
  let finish!: () => void;
  const onCreate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <Theme>
      <TemplateWorkspaceReview inspection={inspection} onCreate={onCreate} />
    </Theme>,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
    target: { value: "my-garden" },
  });
  const button = screen.getByRole("button", { name: "Create workspace" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate).toHaveBeenCalledWith("my-garden", pin);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Workspace name",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  finish();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Workspace name",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false),
  );
});
it("does not let a stale source inspection replace the currently requested source", async () => {
  let finishOld!: (value: typeof inspection) => void;
  const nextPin = { ...pin, commit: "c".repeat(40) };
  const client = {
    catalog: vi.fn(async () => ({
      version: 1 as const,
      revision: "2026-09-07.1",
      source: "verified" as const,
      verifiedAt: "2026-09-07T00:00:00.000Z",
      systemEpoch: 1,
      coordinates: pin,
      stale: false,
      entries: [],
    })),
    inspect: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...inspection,
        pin: nextPin,
        presentation: { name: "Next garden" },
      }),
  };
  const onCreate = vi.fn(async () => undefined);
  const view = render(
    <Theme>
      <TemplateBrowser client={client} initialPin={pin} onCreate={onCreate} />
    </Theme>,
  );
  view.rerender(
    <Theme>
      <TemplateBrowser
        client={client}
        initialPin={nextPin}
        onCreate={onCreate}
      />
    </Theme>,
  );
  await screen.findByRole("heading", { name: "Next garden" });
  await act(async () => {
    finishOld(inspection);
  });
  await waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(2));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  });
  expect(onCreate).toHaveBeenCalledWith("next-garden", nextPin);
});
it("allows ordinary panels to inspect and request host review without creating a workspace", async () => {
  const onOpenInApp = vi.fn(async () => undefined);
  const client = {
    catalog: vi.fn(async () => ({
      version: 1 as const,
      revision: "2026-09-07.1",
      source: "verified" as const,
      verifiedAt: "2026-09-07T00:00:00.000Z",
      systemEpoch: 1,
      coordinates: pin,
      stale: false,
      entries: [],
    })),
    inspect: vi.fn(async () => inspection),
  };
  render(
    <Theme>
      <TemplateBrowser
        client={client}
        initialPin={pin}
        onOpenInApp={onOpenInApp}
      />
    </Theme>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue in app" }),
  );
  expect(onOpenInApp).toHaveBeenCalledWith(inspection);
  expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
});

it("presents the exact pending review and retries only when requested", async () => {
  const failure = Object.assign(new Error("internal extension status"), {
    code: "EREVIEWPENDING",
    errorData: {
      authorityFailure: {
        reasonCode: "review-pending",
        remediation: {
          kind: "resolve-open-review",
          review: { approvalId: "review-templates", title: "System tools" },
        },
      },
    },
  });
  const client = {
    catalog: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null),
    inspect: vi.fn(),
  };
  const onReviewPending = vi.fn();
  render(
    <Theme>
      <TemplateBrowser client={client} onReviewPending={onReviewPending} />
    </Theme>,
  );
  await screen.findByText("Waiting for you to finish reviewing System tools.");
  expect(screen.queryByText("internal extension status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open review" }));
  expect(onReviewPending).toHaveBeenCalledWith("review-templates");
  expect(client.catalog).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(client.catalog).toHaveBeenCalledTimes(2));
});

it("presents a queued runtime acquisition instead of its wrapped error", async () => {
  const failure = Object.assign(new Error("Extension templates.catalog invocation failed"), {
    code: "EACQUIRE",
    errorKind: "access",
    errorData: {
      acquisition: {
        acquisitionId: "acq-templates-network",
        ownerRuntimeId: "panel-system",
        snapshotDigest: "snapshot",
        capability: "network.response.read",
        resourceKey: "https://github.com",
        tier: "gated",
        cardType: "permission.gated",
        renderedAction: "read responses from github.com",
        pending: true,
      },
      authorityFailure: { reasonCode: "approval-required" },
    },
  });
  const client = {
    catalog: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(null),
    inspect: vi.fn(),
  };
  const onReviewPending = vi.fn();
  render(
    <Theme>
      <TemplateBrowser client={client} onReviewPending={onReviewPending} />
    </Theme>,
  );
  await screen.findByText("Your approval is needed to read responses from github.com.");
  expect(screen.queryByText("Extension templates.catalog invocation failed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open approval" }));
  expect(onReviewPending).toHaveBeenCalledWith("acq-templates-network");
  expect(client.catalog).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(client.catalog).toHaveBeenCalledTimes(2));
});
