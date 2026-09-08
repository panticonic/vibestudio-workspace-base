import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("onboarding skill handoff", () => {
  it("takes React and the theme from the panel realm rather than owning them", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    // This skill's components render inside a panel's realm. Owning React here
    // would put a second copy in that realm, where the host's hooks and this
    // skill's hooks stop being the same hooks.
    expect(manifest.dependencies?.["react"]).toBeUndefined();
    expect(manifest.dependencies?.["@radix-ui/themes"]).toBeUndefined();
    expect(manifest.peerDependencies?.["react"]).toMatch(/^\^?\d+\.\d+\.\d+$/u);
    expect(manifest.peerDependencies?.["@radix-ui/themes"]).toMatch(
      /^\^?\d+\.\d+\.\d+$/u,
    );
  });

  it("routes workspace creation directly to the shell surface", () => {
    const skill = fs
      .readFileSync(new URL("SKILL.md", import.meta.url), "utf8")
      .replace(/\s+/gu, " ");

    expect(skill).toContain("**Add workspace** opens the shell-owned creation surface");
    expect(skill).toContain("folder, URL");
    expect(skill).toContain("validated local checkout");
    expect(skill).not.toContain("template-registry");
    expect(skill).not.toContain("onboarding-template");
    expect(skill).not.toContain("contextIntegration");
    expect(skill).not.toContain("vibestudio-template-examples.git");
  });

  it("hands recurring-work intent to the Automations owner", () => {
    const skill = fs
      .readFileSync(new URL("SKILL.md", import.meta.url), "utf8")
      .replace(/\s+/gu, " ");

    expect(skill).toContain(
      "**Schedule recurring work** is a ready-now conversation route",
    );
    expect(skill).toContain("[Automations](../automations/SKILL.md)");
    expect(skill).toContain("launch the automation");
    expect(skill).toContain(
      "immediately appears at that point in the conversation",
    );
    expect(skill).not.toContain("automations setup status");
  });
});
