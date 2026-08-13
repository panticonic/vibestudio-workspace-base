import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill template handoff", () => {
  it("pins the React renderer and its DOM peer to one exact version", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.["react"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.dependencies?.["react-dom"]).toBe(manifest.dependencies?.["react"]);
  });

  it("routes selected registry outcomes through Templates", () => {
    const skill = fs
      .readFileSync(new URL("SKILL.md", import.meta.url), "utf8")
      .replace(/\s+/gu, " ");

    expect(skill).toContain("Template-registry discovery is user-initiated");
    expect(skill).toContain("resolveOnboardingTemplateSelection");
    expect(skill).toContain("exact registry-bound selection");
    expect(skill).toContain("[Templates](../templates/SKILL.md)");
    expect(skill).toMatch(
      /Templates remains the sole (?:install\/update|installation and update) path/u
    );
    expect(skill).not.toContain("vibestudio-template-examples.git");
  });

  it("hands recurring-work intent to the Automations owner", () => {
    const skill = fs
      .readFileSync(new URL("SKILL.md", import.meta.url), "utf8")
      .replace(/\s+/gu, " ");

    expect(skill).toContain("**Schedule recurring work** is a ready-now conversation route");
    expect(skill).toContain("[Automations](../automations/SKILL.md)");
    expect(skill).toContain("propose an inert draft");
    expect(skill).toContain("immediately appears at that point in the conversation");
    expect(skill).not.toContain("automations setup status");
  });
});
