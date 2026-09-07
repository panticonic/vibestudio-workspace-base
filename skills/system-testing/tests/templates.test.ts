import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "../types.js";
import { templateTests } from "./templates.js";

function execution(
  returnValue: unknown,
  final: string,
  options: { code?: string; console?: string } = {},
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      { kind: "message", senderId: "user", complete: true, content: "prompt" },
      {
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        contentType: "invocation",
        invocation: {
          id: "template-overview",
          name: "eval",
          arguments: {
            code:
              options.code ??
              'return extensions.invoke("@workspace-extensions/templates", "catalog", []);',
          },
          execution: {
            status: "complete",
            isError: false,
            result: { details: { returnValue, console: options.console } },
          },
        },
      },
      {
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: final,
      },
    ],
  } as TestExecutionResult;
}

describe("template agentic validator", () => {
  const catalog = templateTests.find(
    ({ name }) => name === "templates-cached-catalog",
  )!;
  it("accepts an observed cache miss without inventing installed relationships", () => {
    expect(
      catalog.validate(execution(null, "No catalog is cached.")),
    ).toMatchObject({ passed: true });
  });
  it("joins the reported count to the observed catalog", () => {
    const snapshot = {
      entries: [{ id: "garden", name: "Garden" }],
      coordinates: { commit: "exact" },
    };
    expect(
      catalog.validate(
        execution(snapshot, "There is 1 cached template: Garden."),
      ),
    ).toMatchObject({ passed: true });
    expect(
      catalog.validate(execution(snapshot, "There are 2 cached templates.")),
    ).toMatchObject({ passed: false });
  });
  it("rejects a claimed cache miss without an observed result", () => {
    expect(
      catalog.validate(execution(undefined, "No catalog is cached.")),
    ).toMatchObject({ passed: false });
  });
  it("rejects refreshing during a cache-only request", () => {
    expect(
      catalog.validate(
        execution(null, "No catalog is cached.", {
          code: 'return extensions.invoke("@workspace-extensions/templates", "catalog", [{ refresh: true }]);',
        }),
      ),
    ).toMatchObject({ passed: false });
  });
  it("does not retain an installed-layer test for the retired product flow", () => {
    expect(templateTests.map((test) => test.name)).toEqual([
      "templates-cached-catalog",
      "templates-authoring-prepare",
    ]);
  });

  it("accepts an exact preparation-only authoring plan", () => {
    const test = templateTests.find(
      ({ name }) => name === "templates-authoring-prepare",
    )!;
    const fingerprint = `v1-sha256:${"a".repeat(64)}`;
    expect(
      test.validate(
        execution(
          {
            available: [{ repoPath: "packages/template-registry" }],
            plan: {
              mainEventId: "event:main",
              fingerprint,
              requestedParts: ["packages/template-registry"],
              includedParts: ["packages/template-registry", "packages/shared"],
              requiredParts: ["packages/shared"],
              manifest: "systemEpoch: 0\n",
            },
          },
          `Prepared the template plan with fingerprint ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const available = await extensions.invoke('@workspace-extensions/templates', 'authoringParts', []);",
              "const plan = await extensions.invoke('@workspace-extensions/templates', 'inspectAuthoring', [{ name: 'Registry', description: 'Template registry', parts: ['packages/template-registry'] }]);",
              "return { available, plan };",
            ].join("\n"),
          },
        ),
      ),
    ).toEqual({ passed: true, reason: undefined });
  });

  it("accepts a structured console receipt when the templates is held in a variable", () => {
    const test = templateTests.find(
      ({ name }) => name === "templates-authoring-prepare",
    )!;
    const fingerprint = `v1-sha256:${"b".repeat(64)}`;
    const plan = {
      fingerprint,
      selectedParts: ["packages/template-registry"],
      includedParts: ["packages/template-registry"],
      requiredParts: [],
      manifest: "systemEpoch: 0\n",
    };
    expect(
      test.validate(
        execution(
          undefined,
          `The exact fingerprint is ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const templates = '@workspace-extensions/templates';",
              "const available = await rpc.call('main', 'extensions.invoke', [templates, 'authoringParts', []]);",
              "const plan = await rpc.call('main', 'extensions.invoke', [templates, 'inspectAuthoring', [{ name: 'Registry', description: 'Template registry', parts: ['packages/template-registry'] }]]);",
              "console.log(JSON.stringify(plan));",
            ].join("\n"),
            console: JSON.stringify(plan),
          },
        ),
      ),
    ).toEqual({ passed: true, reason: undefined });
  });

  it("rejects an authoring trajectory that published in the preparation-only scenario", () => {
    const test = templateTests.find(
      ({ name }) => name === "templates-authoring-prepare",
    )!;
    expect(
      test.validate(
        execution(
          {
            mainEventId: "event:main",
            fingerprint: `v1-sha256:${"a".repeat(64)}`,
            requestedParts: ["packages/template-registry"],
            includedParts: ["packages/template-registry"],
            manifest: "systemEpoch: 0\n",
          },
          "Published.",
          {
            code: [
              "await extensions.invoke('@workspace-extensions/templates', 'authoringParts', []);",
              "const plan = await extensions.invoke('@workspace-extensions/templates', 'inspectAuthoring', [{ name: 'Registry', description: 'Template registry', parts: ['packages/template-registry'] }]);",
              "await extensions.invoke('@workspace-extensions/templates', 'publishAuthoring', [{ plan }]);",
              "return plan;",
            ].join("\n"),
          },
        ),
      ),
    ).toMatchObject({ passed: false });
  });

  it("accepts the reported exact receipt after an earlier draft inspection", () => {
    const test = templateTests.find(
      ({ name }) => name === "templates-authoring-prepare",
    )!;
    const firstFingerprint = `v1-sha256:${"c".repeat(64)}`;
    const finalFingerprint = `v1-sha256:${"d".repeat(64)}`;
    const exactPlan = (fingerprint: string) => ({
      mainEventId: "event:main",
      fingerprint,
      requestedParts: ["packages/template-registry"],
      includedParts: ["packages/template-registry"],
      requiredParts: [],
      manifest: "systemEpoch: 0\n",
    });
    expect(
      test.validate(
        execution(
          {
            drafts: [exactPlan(firstFingerprint), exactPlan(finalFingerprint)],
          },
          `Prepared the final template plan with fingerprint ${finalFingerprint}. Nothing was published.`,
          {
            code: [
              "const templates = '@workspace-extensions/templates';",
              "await extensions.invoke(templates, 'authoringParts', []);",
              "await extensions.invoke(templates, 'inspectAuthoring', [{ name: 'Draft', description: 'First draft', parts: ['packages/template-registry'] }]);",
              "return await extensions.invoke(templates, 'inspectAuthoring', [{ name: 'Final', description: 'Final draft', parts: ['packages/template-registry'] }]);",
            ].join("\n"),
          },
        ),
      ),
    ).toEqual({ passed: true, reason: undefined });
  });

  it("reconstructs one receipt when shared plan values are serialized separately", () => {
    const test = templateTests.find(
      ({ name }) => name === "templates-authoring-prepare",
    )!;
    const fingerprint = `v1-sha256:${"e".repeat(64)}`;
    expect(
      test.validate(
        execution(
          {
            summary: {
              fingerprint,
              requestedParts: ["packages/template-registry"],
              includedParts: ["packages/template-registry"],
            },
            plan: {
              fingerprint,
              mainEventId: "event:main",
              requestedParts: "[Circular]",
              includedParts: "[Circular]",
              manifest: "systemEpoch: 0\n",
            },
          },
          `Prepared the template plan with fingerprint ${fingerprint}. Nothing was published.`,
          {
            code: [
              "const templates = '@workspace-extensions/templates';",
              "await extensions.invoke(templates, 'authoringParts', []);",
              "return await extensions.invoke(templates, 'inspectAuthoring', [{ name: 'Registry', description: 'Template registry', parts: ['packages/template-registry'] }]);",
            ].join("\n"),
          },
        ),
      ),
    ).toEqual({ passed: true, reason: undefined });
  });
});
