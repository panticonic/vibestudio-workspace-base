import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  invocationConsoleOutput,
  walkRecords,
  type ScenarioEvidence,
} from "./_scenario-evidence.js";
import { findLastAgentMessage } from "./_helpers.js";

function exactCount(message: string, value: number): boolean {
  return new RegExp(`(?:^|\\D)${value}(?:\\D|$)`, "u").test(message);
}

function invokedTemplateOperation(code: string, operation: string): boolean {
  if (!code.includes("@workspace-extensions/templates")) return false;
  const quoted = `(["'])${operation}\\1`;
  const convenienceCall = new RegExp(
    `(?:\\bextensions|\\([^)]*\\bextensions\\b[^)]*\\))\\.invoke\\s*\\([^,]+,\\s*${quoted}`,
    "u",
  ).test(code);
  const portableCall =
    /rpc\.call\s*\(\s*(["'])main\1\s*,\s*(["'])extensions\.invoke\2\s*,/u.test(
      code,
    ) && new RegExp(quoted, "u").test(code);
  const indirectCall =
    /extensions\.invoke\s*\([^,]+,\s*[A-Za-z_$][\w$]*/u.test(code) &&
    new RegExp(`\\b[A-Za-z_$][\\w$]*\\s*\\(\\s*${quoted}`, "u").test(code);
  return convenienceCall || portableCall || indirectCall;
}

function consoleStructuredValues(calls: ScenarioEvidence["calls"]): unknown[] {
  const values: unknown[] = [];
  for (const call of calls) {
    const output = invocationConsoleOutput(call);
    if (!output) continue;
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ] as const) {
      const start = output.indexOf(open);
      const end = output.lastIndexOf(close);
      if (start < 0 || end <= start) continue;
      try {
        values.push(JSON.parse(output.slice(start, end + 1)));
      } catch {
        // Console evidence is optional; exact eval return values remain preferred.
      }
    }
  }
  return values;
}

function templateCatalogChecked(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (!invokedTemplateOperation(base.evidence.evalCode, "catalog"))
    return {
      passed: false,
      reason: "No completed template catalog observation",
    };
  if (/refresh\s*:\s*true/u.test(base.evidence.evalCode))
    return {
      passed: false,
      reason: "Cache-only request unexpectedly refreshed the catalog",
    };
  const records = walkRecords([
    ...base.evidence.evalValues,
    ...consoleStructuredValues(base.evidence.calls),
  ]);
  const catalog = records.find(
    (record) =>
      Array.isArray(record["entries"]) &&
      typeof record["coordinates"] === "object",
  );
  const absent =
    base.evidence.evalValues.some((value) => value === null) ||
    records.some(
      (record) =>
        record["catalogUnavailable"] === true ||
        record["catalog"] === null,
    ) ||
    (records.some((record) => record["cached"] === false) &&
      /if\s*\(\s*[A-Za-z_$][\w$]*\s*===\s*null\s*\)\s*return\s*\{[^}]*\bcached\s*:\s*false\b/iu.test(
        base.evidence.evalCode,
      ));
  const final = findLastAgentMessage(result);
  if (!catalog && !absent)
    return {
      passed: false,
      reason:
        "Catalog read did not return a snapshot or an observed cache miss",
    };
  if (absent && !catalog)
    return /cache|unavailable|not available|not cached|no catalog/iu.test(final)
      ? { passed: true }
      : {
          passed: false,
          reason: "Agent did not report the observed unavailable catalog",
        };
  const count = (catalog!["entries"] as unknown[]).length;
  return exactCount(final, count)
    ? { passed: true }
    : {
        passed: false,
        reason: "Agent did not report the observed catalog size",
      };
}

function templateAuthoringPrepared(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  if (
    !invokedTemplateOperation(base.evidence.evalCode, "authoringParts") ||
    !invokedTemplateOperation(base.evidence.evalCode, "inspectAuthoring")
  ) {
    return {
      passed: false,
      reason:
        "Completed eval did not discover parts and inspect an authoring plan",
    };
  }
  if (invokedTemplateOperation(base.evidence.evalCode, "publishAuthoring")) {
    return {
      passed: false,
      reason: "Preparation-only scenario unexpectedly published a template",
    };
  }
  const records = walkRecords([
    ...base.evidence.evalValues,
    ...consoleStructuredValues(base.evidence.calls),
  ]);
  const receipts = new Map<
    string,
    { mainEventId?: string; manifest?: string; requestedParts: Set<string> }
  >();
  for (const record of records) {
    const fingerprint = record["fingerprint"];
    if (
      typeof fingerprint !== "string" ||
      !/^v1-sha256:[0-9a-f]{64}$/u.test(fingerprint)
    ) {
      continue;
    }
    const receipt = receipts.get(fingerprint) ?? {
      requestedParts: new Set<string>(),
    };
    if (typeof record["mainEventId"] === "string") {
      receipt.mainEventId = record["mainEventId"];
    }
    if (typeof record["manifest"] === "string")
      receipt.manifest = record["manifest"];
    const requested = Array.isArray(record["requestedParts"])
      ? record["requestedParts"]
      : Array.isArray(record["requested"])
        ? record["requested"]
        : Array.isArray(record["selectedParts"])
          ? record["selectedParts"]
          : [];
    for (const repoPath of requested) {
      if (typeof repoPath === "string") receipt.requestedParts.add(repoPath);
    }
    receipts.set(fingerprint, receipt);
  }
  const exactReceipts = [...receipts].filter(
    ([, receipt]) =>
      receipt.manifest !== undefined && receipt.requestedParts.size > 0,
  );
  if (!exactReceipts.length) {
    return {
      passed: false,
      reason: "Authoring inspection did not return an exact non-empty plan",
    };
  }
  const selectedReceipts = exactReceipts.filter(([, receipt]) =>
    receipt.requestedParts.has("packages/template-registry"),
  );
  if (!selectedReceipts.length) {
    return {
      passed: false,
      reason:
        "Authoring plan did not select the requested template registry library",
    };
  }
  const final = findLastAgentMessage(result);
  const reportedExactPlan = selectedReceipts.some(([fingerprint]) =>
    final.includes(fingerprint),
  );
  return reportedExactPlan
    ? { passed: true, reason: undefined }
    : {
        passed: false,
        reason: "Final response did not identify the observed exact plan",
      };
}

export const templateTests: TestCase[] = [
  {
    name: "templates-cached-catalog",
    description:
      "Observe the existing verified template catalog without fetching source",
    category: "templates",
    validation: "agent-evidence",
    prompt:
      "How many workspace templates are in the catalog already cached here? Do not fetch, refresh or change anything. If no catalog is cached, tell me that.",
    validate: templateCatalogChecked,
  },
  {
    name: "templates-authoring-prepare",
    description:
      "Prepare a self-contained upstream snapshot from the local template registry library",
    category: "templates",
    validation: "agent-evidence",
    prompt:
      "Prepare a reusable workspace snapshot containing the template registry library. Show me what source and required dependencies it would include, with an exact plan I can review. Do not publish anything.",
    validate: templateAuthoringPrepared,
  },
];
