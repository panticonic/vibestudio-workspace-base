import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function compact(name: "SKILL.md" | "API.md"): string {
  return readFileSync(new URL(name, import.meta.url), "utf8").replace(/\s+/gu, " ");
}

describe("Automations skill contract", () => {
  it("documents immediate launch and the running inspector", () => {
    const skill = compact("SKILL.md");

    expect(skill).toContain("Use this skill when a user asks to run work repeatedly or later");
    expect(skill).toContain("**Method** runs one RPC method");
    expect(skill).toContain("**Agent** sends a prompt through the ordinary agent turn loop");
    expect(skill).toContain("exact inline `eval` code executed without a model call");
    expect(skill).toContain("does not require a new worker");
    expect(skill).toContain("native `launch_automation` tool");
    expect(skill).toContain("canonical active definition");
    expect(skill).toContain("pill is an inspector and controller, not an approval gate");
    expect(skill).toContain("what is running and when it will run next");
  });

  it("documents supervision, history, conversations, results, and errors", () => {
    const skill = compact("SKILL.md");
    const api = compact("API.md");

    expect(skill).toContain("failures from the last 24 hours");
    expect(skill).toContain("paged history");
    expect(skill).toContain("completion response or result/error");
    expect(skill).toContain("links to the exact conversation");
    expect(api).toContain("canonical deep-link identity for that conversation");
    expect(skill).toContain("chat-history pill");
    expect(api).toContain("`automation.instituted` event");
    expect(api).toContain("Opening it calls only `get`; no run exists yet");
    expect(skill).toContain("Collapsed transcript pills perform no service reads");
    expect(skill).toContain(
      "Agents can use the agent-facing `edit`, `runNow`, `pause`, `resume`, and"
    );
    expect(api).toContain("there is no proposal or review transition");
  });

  it("documents interval, calendar, finite, and natural-completion schedules", () => {
    const skill = compact("SKILL.md");
    const api = compact("API.md");

    expect(skill).toContain('kind: "schedule"');
    expect(skill).toContain('kind: "cron"');
    expect(skill).toContain('expression: "5 5 * * THU"');
    expect(skill).toContain('timezone: "America/New_York"');
    expect(skill).toContain("no run begins at or after");
    expect(skill).toContain("failed runs count, while visible overlap skips do not");
    expect(skill).toContain("`complete_automation` tool");
    expect(api).toContain('protocol: "automation-completion.v1"');
    expect(api).toContain("transitions the definition to `completed`");
    expect(skill).toContain("plain-language rules");
    expect(skill).toContain("five concrete upcoming runs");
    expect(api).toContain("round-trips common hourly, daily, weekly, and monthly expressions");
    expect(api).toContain("Both paths save the same canonical `cron` trigger");
  });
});
