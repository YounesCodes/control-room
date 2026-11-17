import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import registry from "./scenarios.json";
import map from "./features.json";
import type { Feature } from "./features";

const features = map.features as Feature[];
const docsRoot = new URL("../../../docs/src/content/docs/", import.meta.url);
const scenarios: Record<string, { states: string[] }> = registry.scenarios;
const kinds = ["toolbar", "sidebar", "tabs", "settings", "menu", "page", "palette", "shortcut"];

function headingSlug(heading: string) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function docsAnchors(page: string) {
  return readFileSync(new URL(page, docsRoot), "utf8")
    .split("\n")
    .flatMap((line) => (/^#{2,6}\s/.test(line) ? [headingSlug(line.replace(/^#+/, ""))] : []));
}

function fixtureExists({ scenario, state }: { scenario: string; state: string }) {
  return Object.hasOwn(scenarios, scenario) && scenarios[scenario].states.includes(state);
}

describe("feature map", () => {
  it("names each feature once", () => {
    const names = features.map((feature) => feature.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("resolves entry points against a registered capture fixture", () => {
    expect(fixtureExists(map.fixture)).toBe(true);
    for (const feature of features) {
      expect(feature.entryPoints.length, feature.name).toBeGreaterThan(0);
      for (const entry of feature.entryPoints) {
        expect(kinds, feature.name).toContain(entry.kind);
        if (entry.kind === "shortcut") continue;
        expect(entry.role && entry.name, feature.name).toBeTruthy();
        if (entry.kind === "palette") expect(entry.role, feature.name).toBe("option");
        if (entry.fixture) expect(fixtureExists(entry.fixture), feature.name).toBe(true);
        if (entry.viewport) expect(Object.keys(registry.viewports)).toContain(entry.viewport);
        for (const platform of entry.platforms ?? [])
          expect(["windows", "linux", "macos"], feature.name).toContain(platform);
      }
    }
  });

  it("references capture scenarios and states that exist", () => {
    for (const feature of features) {
      if (feature.capture === null) continue;
      expect(feature.capture.length, feature.name).toBeGreaterThan(0);
      for (const { scenario, states } of feature.capture) {
        expect(Object.keys(scenarios), feature.name).toContain(scenario);
        expect(states.length, feature.name).toBeGreaterThan(0);
        for (const state of states)
          expect(scenarios[scenario].states, feature.name).toContain(state);
      }
    }
  });

  it("assigns every capture state to a feature", () => {
    const mapped = new Set(
      features.flatMap((feature) =>
        (feature.capture ?? []).flatMap(({ scenario, states }) =>
          states.map((state) => `${scenario}/${state}`),
        ),
      ),
    );
    const unmapped = Object.entries(scenarios).flatMap(([scenario, { states }]) =>
      states.map((state) => `${scenario}/${state}`).filter((state) => !mapped.has(state)),
    );
    expect(unmapped).toEqual([]);
  });

  it("links docs pages and headings that exist", () => {
    for (const feature of features) {
      if (feature.docs === null) continue;
      const [page, anchor] = feature.docs.split("#");
      expect(existsSync(new URL(page, docsRoot)), feature.docs).toBe(true);
      if (anchor) expect(docsAnchors(page), feature.docs).toContain(anchor);
    }
  });

  it("lists only shortcuts the keyboard reference documents", () => {
    const reference = readFileSync(new URL("reference/keyboard-shortcuts.md", docsRoot), "utf8");
    for (const feature of features)
      for (const entry of feature.entryPoints)
        if (entry.kind === "shortcut")
          expect(reference, feature.name).toContain(`\`${entry.keys}\``);
  });
});
