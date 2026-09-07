// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingCapabilityApproval } from "@vibestudio/shared/approvals";
import { approvalPresentationKey } from "@vibestudio/shared/approvalPresentation";
import { useApprovalPresentationController } from "./ApprovalPresentationContext";
import { useShellWorkspaceClient } from "../shell/workspaceContext";
vi.mock("../shell/client", () => ({}));
const approval = (approvalId: string): PendingCapabilityApproval => ({
  kind: "capability",
  approvalId,
  callerId: "panel:test",
  callerKind: "panel",
  repoPath: "panels/test",
  effectiveVersion: "ev",
  requestedAt: 1,
  capability: "context.boundary",
  title: "Review access"
});
const mount = () => renderHook(() => useApprovalPresentationController(useShellWorkspaceClient()));

describe("window approval presentation", () => {
  it("keeps a minimized selection stable across owner refreshes and separates identical IDs", () => {
    const { result } = mount();
    const personal = Symbol();
    const team = Symbol();
    act(() => result.current.publish("personal", personal, [approval("same")]));
    act(() => result.current.publish("team", team, [approval("same")]));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.state.selectedKey).toBe(
      approvalPresentationKey({ workspaceId: "personal", approvalId: "same" })
    );
    act(() => result.current.minimize());
    act(() =>
      result.current.publish("team", team, [{ ...approval("same"), title: "Updated description" }])
    );
    expect(result.current.state.open).toBe(false);
    act(() => result.current.request("team", "same"));
    expect(result.current.state.open).toBe(true);
    expect(result.current.state.selectedKey).toBe(
      approvalPresentationKey({ workspaceId: "team", approvalId: "same" })
    );
  });

  it("selects an exact deferred review and removes revoked owners without erasing a replacement", () => {
    const { result } = mount();
    const old = Symbol();
    const replacement = Symbol();
    act(() => result.current.request("team", "wanted"));
    act(() => result.current.publish("team", old, [approval("first"), approval("wanted")]));
    expect(result.current.state.selectedKey).toBe(
      approvalPresentationKey({ workspaceId: "team", approvalId: "wanted" })
    );
    act(() => result.current.publish("team", replacement, [approval("replacement")]));
    act(() => result.current.remove("team", old));
    expect(result.current.entries.map((entry) => entry.approvalId)).toEqual(["replacement"]);
    act(() => result.current.remove("team", replacement));
    expect(result.current.entries).toEqual([]);
    expect(result.current.state.selectedKey).toBeNull();
  });
});
