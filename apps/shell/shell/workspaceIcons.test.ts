import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { createWorkspaceIcons } from "./workspaceIcons";
afterEach(() => vi.restoreAllMocks());
it("fetches identical resource coordinates through each owning session and retires its own cache", async () => {
  const personalStream = vi.fn(
    async () => new Response("personal icon", { headers: { "content-type": "image/svg+xml" } })
  );
  const projectStream = vi.fn(
    async () => new Response("project icon", { headers: { "content-type": "image/svg+xml" } })
  );
  const personal = createWorkspaceIcons({ stream: personalStream } as Pick<RpcClient, "stream">);
  const project = createWorkspaceIcons({ stream: projectStream } as Pick<RpcClient, "stream">);
  const input = ["panels/editor", "./icon.svg", "a".repeat(64), "b".repeat(64)] as const;
  expect(await personal.load(...input)).toBe(`data:image/svg+xml;base64,${btoa("personal icon")}`);
  expect(await project.load(...input)).toBe(`data:image/svg+xml;base64,${btoa("project icon")}`);
  expect(await personal.load(...input)).toBe(`data:image/svg+xml;base64,${btoa("personal icon")}`);
  expect(personalStream).toHaveBeenCalledTimes(1);
  expect(projectStream).toHaveBeenCalledTimes(1);
  expect(personalStream.mock.calls[0]).toEqual([
    "main",
    "gateway.fetch",
    [
      {
        path: `/__vibestudio/unit-icon?source=panels%2Feditor&path=icon.svg&v=${input[2]}&s=${input[3]}`,
        method: "GET"
      }
    ],
    { signal: expect.any(AbortSignal) }
  ]);
  personal.close();
  await expect(personal.load(...input)).rejects.toThrow("closed");
  expect(await project.load(...input)).toBe(`data:image/svg+xml;base64,${btoa("project icon")}`);
  project.close();
});
it("aborts a retiring owner and never retains a late icon response", async () => {
  let finish!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const stream = vi.fn(() => response);
  const icons = createWorkspaceIcons({ stream } as Pick<RpcClient, "stream">);
  const pending = icons.load("panels/editor", "./icon.svg");
  icons.close();
  finish(new Response("late icon"));
  await expect(pending).rejects.toThrow("closed");
});
it("cancels an error response body instead of leaving its request stream open", async () => {
  const cancel = vi.fn();
  const icons = createWorkspaceIcons({
    stream: vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 }))
  } as Pick<RpcClient, "stream">);
  await expect(icons.load("panels/editor", "./icon.svg")).rejects.toThrow("404");
  expect(cancel).toHaveBeenCalledTimes(1);
  icons.close();
});

it("bounds the image payload forwarded to native overlays and cancels oversized bodies", async () => {
  const cancel = vi.fn();
  const icons = createWorkspaceIcons({
    stream: vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel
          }),
          { headers: { "content-type": "image/png" } }
        )
    )
  } as Pick<RpcClient, "stream">);
  await expect(icons.load("panels/editor", "./icon.svg")).rejects.toThrow("1 MiB");
  expect(cancel).toHaveBeenCalledTimes(1);
  icons.close();
});

it("deduplicates live requests only while pending and refetches changed icon bytes", async () => {
  const stream = vi
    .fn()
    .mockResolvedValueOnce(new Response("old", { headers: { "content-type": "image/svg+xml" } }))
    .mockResolvedValueOnce(new Response("new", { headers: { "content-type": "image/svg+xml" } }));
  const icons = createWorkspaceIcons({ stream } as Pick<RpcClient, "stream">);
  const first = icons.load("workers/mail", "./icon.svg");
  expect(icons.load("workers/mail", "./icon.svg")).toBe(first);
  expect(await first).toBe(`data:image/svg+xml;base64,${btoa("old")}`);
  expect(await icons.load("workers/mail", "./icon.svg")).toBe(
    `data:image/svg+xml;base64,${btoa("new")}`
  );
  expect(stream).toHaveBeenCalledTimes(2);
  icons.close();
});
