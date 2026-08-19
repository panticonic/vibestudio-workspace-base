import { describe, expect, it } from "vitest";
import { DECK, sceneIndex } from "./deck";

describe("tour deck", () => {
  it("has unique scene ids with notes", () => {
    const ids = DECK.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scene of DECK) expect(scene.notes.length).toBeGreaterThan(0);
  });

  it("resolves unknown or missing ids to the opening scene", () => {
    expect(sceneIndex(undefined)).toBe(0);
    expect(sceneIndex("nope")).toBe(0);
    expect(sceneIndex("continuum")).toBe(DECK.findIndex((s) => s.id === "continuum"));
  });
});
