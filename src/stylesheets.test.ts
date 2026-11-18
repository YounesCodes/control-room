/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parsedStylesheets,
  parseStylesheet,
  splitTopLevel,
  stylesEntry,
  stylesheetPaths,
  type StylesheetRule,
} from "./test/stylesheets";

const tokensSheet = "./styles/tokens.css";

const featureSheetOwners: Record<string, RegExp> = {
  "./styles/features/metrics.css": /^(host-metric|step-slider)/,
  "./styles/features/update.css": /^(update-|release-notes)/,
  "./styles/features/terminal.css":
    /^(session-|new-terminal-menu$|terminal-(?!focus-mode|appearance|color))/,
  "./styles/features/scratchpad.css": /^scratchpad-/,
  "./styles/features/systemd.css": /^systemd-(?!list-controls$)/,
  "./styles/features/logs.css": /^logs?-/,
  "./styles/features/history.css": /^history-/,
  "./styles/features/settings.css": /^(settings-(?!mode$)|terminal-appearance|terminal-color)/,
  "./styles/features/dialogs.css":
    /^(modal|remote-shell-|known-tag|tag-color|connection-(organization|dialog|form|key-field|test|tag-selector|groups-dialog|group-(create|list|manage|delete)|tag-(create|color|manage|delete)))/,
  "./styles/features/command-palette.css": /^command-/,
  "./styles/features/ports.css": /^(ports-(?!page$)|port-list-controls$)/,
  "./styles/features/font-catalog.css": /^font-/,
};

const scopedTokenOverrides: Record<string, string[]> = {
  "--identity-size": [".settings-form .local-shell-icon", ".remote-shell-host .host-os-icon"],
};

function stylesheetFilesOnDisk(directory = new URL("./styles/", import.meta.url)): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return stylesheetFilesOnDisk(new URL(`${entry.name}/`, directory));
    if (!entry.name.endsWith(".css")) return [];
    const path = new URL(entry.name, directory).href;
    return [`./${path.slice(new URL("./", import.meta.url).href.length)}`];
  });
}

function withoutFunctionalArguments(selector: string): string {
  let depth = 0;
  let kept = "";
  for (const character of selector) {
    if (character === "(") depth++;
    if (depth === 0) kept += character;
    if (character === ")") depth--;
  }
  return kept;
}

function featureOf(className: string): string | undefined {
  return Object.keys(featureSheetOwners).find((sheet) => featureSheetOwners[sheet].test(className));
}

function ruleFeature(rule: StylesheetRule): string | undefined {
  const features = new Set(
    splitTopLevel(rule.selector, ",").map((selector) => {
      const className = [...withoutFunctionalArguments(selector).matchAll(/\.([\w-]+)/g)].at(
        -1,
      )?.[1];
      return className && featureOf(className);
    }),
  );
  return features.size === 1 ? [...features][0] : undefined;
}

const sheets = parsedStylesheets();
const rules = sheets.flatMap((sheet) => sheet.rules);

describe("stylesheet structure", () => {
  it("imports every sheet exactly once from a flat entry that holds nothing else", () => {
    const entry = parseStylesheet("styles.css", readFileSync(stylesEntry, "utf8"));
    const imports = stylesheetPaths();
    expect(entry.rules, "styles.css only lists @import lines").toEqual([]);
    expect(entry.atRules).toEqual([]);
    expect(imports[0], "tokens load before every sheet that reads them").toBe(tokensSheet);
    expect(new Set(imports).size).toBe(imports.length);
    expect([...imports].sort()).toEqual(stylesheetFilesOnDisk().sort());
    for (const sheet of sheets) {
      expect(sheet.imports, `${sheet.sheet} imports another sheet`).toEqual([]);
    }
  });

  it("defines design tokens only in the tokens sheet", () => {
    const tokenRules = rules.filter((rule) => rule.sheet === tokensSheet);
    expect(tokenRules.length).toBeGreaterThan(0);
    const tokens = new Set<string>();
    for (const rule of tokenRules) {
      expect(rule.selector, "tokens.css holds only :root token rules").toBe(":root");
      expect(rule.conditions).toEqual([]);
      for (const { property } of rule.declarations) {
        expect(property, "tokens.css holds only custom properties").toMatch(/^--/);
        expect(tokens.has(property), `${property} is defined twice`).toBe(false);
        tokens.add(property);
      }
    }
    for (const rule of rules.filter((candidate) => candidate.sheet !== tokensSheet)) {
      for (const { property } of rule.declarations.filter((declaration) =>
        declaration.property.startsWith("--"),
      )) {
        const where = `${rule.sheet} ${rule.selector}`;
        expect(
          rule.selector,
          `${property} in ${where} is a token: define it in tokens.css`,
        ).not.toMatch(/(^|,\s*):root\b/);
        if (tokens.has(property)) {
          expect(
            scopedTokenOverrides[property] ?? [],
            `${where} overrides the ${property} token`,
          ).toContain(rule.selector);
        }
      }
    }
  });

  it("names an owner for every feature sheet and no class for two owners", () => {
    expect(
      stylesheetFilesOnDisk()
        .filter((path) => path.startsWith("./styles/features/"))
        .sort(),
    ).toEqual(Object.keys(featureSheetOwners).sort());
    const classNames = new Set(
      rules.flatMap((rule) => [...rule.selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1])),
    );
    for (const className of classNames) {
      const owners = Object.keys(featureSheetOwners).filter((sheet) =>
        featureSheetOwners[sheet].test(className),
      );
      expect(owners.length, `.${className} matches ${owners.join(", ")}`).toBeLessThanOrEqual(1);
    }
  });

  it("keeps rules that style only one feature's elements in that feature's sheet", () => {
    const misplaced = rules
      .map((rule) => ({ rule, feature: ruleFeature(rule) }))
      .filter(({ rule, feature }) => feature && feature !== rule.sheet)
      .map(({ rule, feature }) => `${rule.selector} in ${rule.sheet} belongs in ${feature}`);
    expect(misplaced).toEqual([]);
  });
});
