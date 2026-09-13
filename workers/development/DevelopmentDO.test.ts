import { describe, expect, it, vi } from "vitest";

import { DURABLE_OBJECT_FRAMEWORK_RPC_METHODS } from "@vibestudio/durable";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { developmentBuiltinMethods } from "@vibestudio/service-schemas/development";
import { DevelopmentDO } from "./DevelopmentDO.js";

async function development() {
  return createTestDO(DevelopmentDO, {
    WORKER_SOURCE: "vibestudio/internal",
    WORKER_CLASS_NAME: "DevelopmentDO",
    __objectKey: "workspace",
  });
}

describe("DevelopmentDO", () => {
  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await development();
    const methods = [...rpcExposedMethodNames(instance)].filter(
      (method) => !DURABLE_OBJECT_FRAMEWORK_RPC_METHODS.has(method),
    );
    expect(methods.sort()).toEqual(
      Object.keys(developmentBuiltinMethods).sort(),
    );
  });

  it("owns reviewed recipe selection while the host supplies only its platform", async () => {
    const { instance, callAs } = await development();
    const rpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "developmentNative.describeHost") {
        return { platform: "linux", arch: "x64" };
      }
      throw new Error(`Unexpected ${method}`);
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    const recipes = await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "listRecipes",
    );
    expect(recipes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipeId: "vibestudio-monorepo-build-v1",
          platform: "linux",
          arch: "x64",
        }),
      ]),
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "developmentNative.describeHost",
      [],
    );
  });

  it("resolves session repositories through the reviewed public VCS surface", async () => {
    const { instance, callAs } = await development();
    const parentHead = { kind: "event" as const, eventId: "event:parent" };
    const childHead = { kind: "event" as const, eventId: "event:child" };
    const workspaceSource =
      "do:workers/workspace-source:GadWorkspaceDO:workspace";
    const rpcCall = vi.fn(
      async (target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "runtime.resolveContext")
          return "context:parent";
        if (
          target === "main" &&
          method === "developmentNative.resolveAdoptedRepository"
        ) {
          const [input] = args as [{ contextId: string }];
          return {
            repoPath: "projects/vibestudio",
            workingHead:
              input.contextId === "context:parent" ? parentHead : childHead,
          };
        }
        if (target === "main" && method === "runtime.forkSemanticContext") {
          expect(args).toEqual([
            {
              ownerRuntimeId: "panel:development",
              parentContextId: "context:parent",
              targetContextId: expect.stringMatching(/^ctx-development-/),
            },
          ]);
          return {
            contextId: "context:child",
            parentContextId: "context:parent",
            parentWorkingHead: parentHead,
            childBaseState: childHead,
          };
        }
        if (
          target === "main" &&
          method === "developmentNative.prepareTemplateExchange"
        ) {
          return {
            intentDigest: "a".repeat(64),
            plan: {
              format: "vibestudio-template-exchange-plan/1",
              direction: "export",
              workspace: "/owned/semantic",
              checkout: "/checkouts/base",
              source: "/owned/semantic",
              target: "/checkouts/base",
              manifestDigest: "c".repeat(64),
              baselineDigest: null,
              projection: ["meta/vibestudio.yml"],
              paths: [],
              conflicts: [],
              untouched: [],
              operationId: "b".repeat(64),
            },
          };
        }
        if (
          target === "main" &&
          method === "developmentNative.applyTemplateExchange"
        ) {
          return {
            direction: "export",
            exchange: {
              format: "vibestudio-template-exchange-receipt/1",
              operationId: "b".repeat(64),
              direction: "export",
              manifestDigest: "c".repeat(64),
              baselineBefore: null,
              baselineAfter: "d".repeat(64),
              written: [],
              deleted: [],
              preserved: [],
              completedAt: new Date(0).toISOString(),
            },
            imported: null,
          };
        }
        throw new Error(`Unexpected ${method}`);
      },
    );
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    const opened = await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "openSession",
      {
        repositoryId: "repository:vibestudio",
        mode: "semantic",
        idempotencyKey: "open:self-development",
      },
    );

    expect(opened).toMatchObject({
      kind: "opened",
      session: {
        contextId: "context:child",
        repository: {
          repositoryId: "repository:vibestudio",
          repoPath: "projects/vibestudio",
        },
      },
    });
    // The owner's context and the forked child are both read through the host,
    // which is the only principal the workspace-source receiver admits — and
    // nothing addresses that object directly.
    expect(
      rpcCall.mock.calls
        .filter(
          ([target, method]) =>
            target === "main" &&
            method === "developmentNative.resolveAdoptedRepository",
        )
        .map(([, , args]) => args),
    ).toEqual([
      [{ contextId: "context:parent", repositoryId: "repository:vibestudio" }],
      [{ contextId: "context:child", repositoryId: "repository:vibestudio" }],
    ]);
    expect(
      rpcCall.mock.calls.filter(([target]) => target === workspaceSource),
    ).toEqual([]);
    const sessionId = (
      opened as { kind: "opened"; session: { sessionId: string } }
    ).session.sessionId;
    await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "planTemplateExchange",
      {
        sessionId,
        direction: "export",
        checkout: "/checkouts/base",
        idempotencyKey: "exchange:one",
      },
    );
    await callAs(
      { callerId: "panel:development", callerKind: "panel", userId: "alice" },
      "applyTemplateExchange",
      {
        sessionId,
        operationId: "b".repeat(64),
        intentDigest: "a".repeat(64),
        checkout: "/checkouts/base",
      },
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "developmentNative.prepareTemplateExchange",
      [
        expect.objectContaining({
          contextId: "context:child",
          repositoryId: "repository:vibestudio",
          expectedWorkingHead: childHead,
          checkout: "/checkouts/base",
        }),
      ],
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "developmentNative.applyTemplateExchange",
      [
        {
          operationId: "b".repeat(64),
          intentDigest: "a".repeat(64),
          checkout: "/checkouts/base",
        },
      ],
    );
  });
});
