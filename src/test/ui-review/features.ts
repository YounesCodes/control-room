import type registry from "./scenarios.json";

export type FixtureReference = { scenario: string; state: string };

export type FixtureAction = { role: string; name: string; key?: string };

type Located = {
  role: string;
  name: string;
  within?: { role: string; name: string };
  open?: FixtureAction[];
  fixture?: FixtureReference;
  viewport?: keyof typeof registry.viewports;
};

export type EntryPoint =
  | { kind: "shortcut"; keys: string }
  | (Located & { kind: "palette"; role: "option" })
  | (Located & { kind: "toolbar" | "sidebar" | "tabs" | "settings" | "menu" | "page" });

export type Feature = {
  name: string;
  docs: string | null;
  capture: { scenario: string; states: string[] }[] | null;
  entryPoints: EntryPoint[];
};
