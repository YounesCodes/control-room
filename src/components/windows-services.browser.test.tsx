import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { ConnectionSection } from "./ResizablePanels";
import { WindowsServicesPane } from "../pages/WindowsServicesPane";
import type { SavedConnection } from "../types";
import "../styles.css";

vi.mock("../lib/api", () => ({
  api: {
    listWindowsServices: vi.fn(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        id: `service-${index}`,
        displayName: `Example service ${String(index).padStart(3, "0")}`,
        description: "Example Windows service",
        state: "running",
        startMode: "Auto",
        processId: index + 1,
      })),
    ),
  },
  errorMessage: String,
}));
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  host?.remove();
});

describe("Windows service layout", () => {
  it.each([960, 500])("keeps the last service reachable in a %s px pane", async (width) => {
    await page.viewport(width + 40, 680);
    host = document.createElement("div");
    host.style.cssText = `position:relative;width:${width}px;height:560px`;
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <ConnectionSection section="services">
        <WindowsServicesPane connection={{ id: "example-host" } as SavedConnection} />
      </ConnectionSection>,
    );
    await expect
      .element(page.getByRole("button", { name: /Example service 099/ }))
      .toBeInTheDocument();
    const pane = host.querySelector<HTMLElement>(".list-panel")!;
    expect(pane.getBoundingClientRect().height).toBeLessThanOrEqual(560);
    expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight);
    await userEvent.click(page.getByRole("button", { name: /Example service 000/ }));
    await userEvent.keyboard("{End}");
    await vi.waitFor(() =>
      expect(pane.scrollTop + pane.clientHeight).toBeGreaterThanOrEqual(pane.scrollHeight - 1),
    );
    pane.scrollTop = pane.scrollHeight;
    expect(pane.scrollTop).toBeGreaterThan(0);
    await userEvent.click(page.getByRole("button", { name: /Example service 099/ }));
    expect(host.querySelector(".detail-panel h2")?.textContent).toBe("Example service 099");
    pane.scrollTop = 0;
    await userEvent.hover(page.getByRole("textbox", { name: "Search Windows services" }));
    await vi.waitFor(() => expect(pane.scrollTop).toBe(0));
    const field = host.querySelector<HTMLElement>(".search-field")!;
    const icon = field.querySelector("svg")!;
    const filter = page.getByRole("combobox", { name: "Filter service state" }).element();
    expect(
      icon.getBoundingClientRect().left - field.getBoundingClientRect().left,
    ).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(getComputedStyle(field.parentElement!).gap)).toBeGreaterThanOrEqual(8);
    expect(filter.getBoundingClientRect().width).toBeGreaterThan(90);
    expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth);
    const accessibility = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(accessibility.violations).toEqual([]);
    await page
      .getByRole("group", { name: "Services panes" })
      .screenshot({ path: `../../test-results/windows-services-${width}.png` });
  });
});
