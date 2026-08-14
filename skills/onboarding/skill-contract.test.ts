import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill template handoff", () => {
  it("takes React and the theme from the panel realm rather than owning them", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("package.json", import.meta.url), "utf8")
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

    // This skill's components render inside a panel's realm. Owning React here
    // would put a second copy in that realm, where the host's hooks and this
    // skill's hooks stop being the same hooks.
    expect(manifest.dependencies?.["react"]).toBeUndefined();
    expect(manifest.dependencies?.["@radix-ui/themes"]).toBeUndefined();
    expect(manifest.peerDependencies?.["react"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.peerDependencies?.["@radix-ui/themes"]).toMatch(/^\d+\.\d+\.\d+$/u);
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
