import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function docs(): string {
  return ["SKILL.md", "API.md"]
    .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
    .join("\n");
}

describe("Automations skill contract", () => {
  it("teaches immediate launch and a durable inspector instead of a proposal flow", () => {
    const value = docs();
    expect(value).toContain("call `launch_automation` directly");
    expect(value).toContain("creates an active automation immediately");
    expect(value).toContain("controller, not an approval gate");
    expect(value).not.toMatch(
      /reviewed closure|proposal transition|approve automation/iu,
    );
  });

  it("keeps semantic operations separate from host-derived authority", () => {
    const value = docs();
    expect(value).toContain("semantic service operation");
    expect(value).toContain("never authors capability rows");
    expect(value).toContain("mission:<id>@<revisionDigest>");
    expect(value).toContain(
      "Channel IDs are routing facts, never authority subjects",
    );
    expect(value).not.toContain("MissionPermission");
    expect(value).not.toContain("toolExposure");
  });

  it("documents pre-acquisition with ordinary runtime approval fallback", () => {
    const value = docs();
    expect(value).toContain("durable acquisition");
    expect(value).toContain("ordinary acquisition");
    expect(value).toContain(
      "do not force automation eval into `pregranted-only`",
    );
    expect(value).toContain(
      "Pause and resume therefore preserve the same subject and grants",
    );
  });

  it("documents exact scheduling and resumable run phases", () => {
    const value = docs();
    expect(value).toContain('kind: "schedule"');
    expect(value).toContain('kind: "cron"');
    expect(value).toContain('timezone: "America/New_York"');
    expect(value).toContain('protocol: "automation-completion.v1"');
    expect(value).toContain('"waiting-authority"');
    expect(value).toContain(
      "resumes existing nonterminal runs before admitting newly due runs",
    );
  });
});
