import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import registry from "./scenarios.json";
import map from "./features.json";
import type {
  ClientPlatform,
  EntryPoint,
  Feature,
  FixtureAction,
  FixtureReference,
} from "./features";
import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter/opsz.css";
import "../../styles.css";

type Native = typeof import("./native");
const fixture = vi.hoisted(() => ({ native: null as Native | null }));
const native = () => fixture.native!;
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = null;
  },
  invoke: (command: string, args?: Record<string, unknown>) => native().invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, callback: (event: { payload: unknown }) => void) =>
    native().listen(name, callback),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native().getCurrentWindow() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => native().open(),
  save: () => native().save(),
}));
import { App } from "../../App";

let mounted: { root: Root; element: HTMLElement } | null = null;
let mounts = 0;
const platform: ClientPlatform = navigator.platform.startsWith("Mac")
  ? "macos"
  : navigator.platform.startsWith("Linux")
    ? "linux"
    : "windows";
const appModifier = platform === "macos" ? "Meta" : "Control";

afterEach(() => {
  mounted?.root.unmount();
  mounted?.element.remove();
  mounted = null;
});

async function mount({ scenario, state }: FixtureReference) {
  const location = window.location.href;
  const query = new URLSearchParams({ scenario, state });
  history.replaceState(history.state, "", `?${query}`);
  try {
    fixture.native = await import(/* @vite-ignore */ `./native.ts?${query}&mount=${++mounts}`);
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    root.render(createElement(App));
    mounted = { root, element };
  } finally {
    history.replaceState(history.state, "", location);
  }
  const { ready } = registry.scenarios[scenario as keyof typeof registry.scenarios];
  await expect.poll(() => document.querySelector(ready)).toBeTruthy();
}

function locate(role: string, name: string, within?: { role: string; name: string }) {
  const scope = within
    ? page.getByRole(within.role as never, { name: within.name, exact: true })
    : page;
  return scope.getByRole(role as never, { name, exact: true });
}

async function perform({ role, name, key }: FixtureAction) {
  const target = locate(role, name);
  if (!key) return target.click();
  await expect.element(target).toBeInTheDocument();
  (target.element() as HTMLElement).focus();
  await userEvent.keyboard(`{${key}}`);
}

function paletteOptionLabels() {
  return Array.from(document.querySelectorAll('[role="option"]'), (option) => ({
    label: option.querySelector("strong")?.textContent ?? "",
    keys: Array.from(option.querySelectorAll("kbd"), (key) => key.textContent)
      .join("+")
      .replace(/^Cmd\+/, "Ctrl+"),
  }));
}

async function resolve(entry: Exclude<EntryPoint, { kind: "shortcut" }>, shortcuts: string[]) {
  const viewport = registry.viewports[entry.viewport ?? "normal"];
  await page.viewport(viewport.width, viewport.height);
  await mount(entry.fixture ?? map.fixture);
  for (const action of entry.open ?? []) await perform(action);
  if (entry.kind === "palette") {
    await userEvent.keyboard(`{${appModifier}>}{Shift>}P{/Shift}{/${appModifier}}`);
    await expect.element(page.getByRole("listbox")).toBeVisible();
    const option = paletteOptionLabels().find(({ label }) => label === entry.name);
    expect(option, `Command palette lists ${entry.name}`).toBeDefined();
    if (option!.keys) expect(shortcuts).toContain(option!.keys);
    return;
  }
  await expect.element(locate(entry.role, entry.name, entry.within)).toBeVisible();
}

const cases = (map.features as Feature[]).flatMap((feature) => {
  const shortcuts = feature.entryPoints.flatMap((entry) =>
    entry.kind === "shortcut" ? [entry.keys] : [],
  );
  return feature.entryPoints.flatMap((entry) =>
    entry.kind === "shortcut"
      ? []
      : [[feature.name, `${entry.kind} ${entry.role} "${entry.name}"`, entry, shortcuts] as const],
  );
});

describe("feature map entry points", () => {
  it.for(cases)("%s: %s", async ([, , entry, shortcuts], { skip }) => {
    if (entry.platforms && !entry.platforms.includes(platform)) skip();
    await resolve(entry, shortcuts);
  });
});
