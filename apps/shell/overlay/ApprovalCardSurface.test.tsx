// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelIcon } from "../components/PanelIcon";
import { ApprovalCardSurface } from "./ApprovalCardSurface";

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: () => <PanelIcon source="workers/mail" icon="./icon.svg" fallback="worker" />
}));
afterEach(cleanup);
it("renders only captured exact icon coordinates without an ambient client or origin fallback", async () => {
  const approval = {
    approvalId: "first",
    kind: "capability",
    callerId: "worker:mail",
    callerKind: "worker",
    repoPath: "workers/mail",
    effectiveVersion: "v1",
    title: "Read mail"
  };
  const ownUrl = "data:image/svg+xml;base64,PHN2Zy8+";
  const key = JSON.stringify(["workers/mail", "./icon.svg", null, null]);
  const emitIntent = vi.fn();
  const { container, rerender } = render(
    <ApprovalCardSurface
      props={{ approval, queue: null, decisionError: null, iconUrls: { [key]: ownUrl } }}
      emitIntent={emitIntent}
    />
  );
  await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(ownUrl));
  rerender(
    <ApprovalCardSurface
      props={{
        approval: { ...approval, approvalId: "second" },
        queue: null,
        decisionError: null,
        iconUrls: { unrelated: ownUrl }
      }}
      emitIntent={emitIntent}
    />
  );
  expect(container.querySelector("img")).toBeNull();
  await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
  expect(emitIntent).not.toHaveBeenCalled();
});
