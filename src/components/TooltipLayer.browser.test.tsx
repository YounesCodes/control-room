import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { TooltipLayer } from "./TooltipLayer";
import "../styles.css";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  container?.remove();
});

function mount(edge: "left" | "right" | "bottom", title: string) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() =>
    root!.render(
      <>
        <button
          title={title}
          style={{
            position: "fixed",
            width: 40,
            height: 30,
            left: edge === "right" ? undefined : 0,
            right: edge === "right" ? 0 : undefined,
            top: edge === "bottom" ? undefined : 0,
            bottom: edge === "bottom" ? 0 : undefined,
          }}
        >
          Target
        </button>
        <TooltipLayer />
      </>,
    ),
  );
}

describe("tooltip viewport bounds", () => {
  for (const edge of ["left", "right", "bottom"] as const) {
    it(`keeps a long tooltip inside the ${edge} window edge`, async () => {
      await page.viewport(800, 600);
      mount(edge, "DEBIAN DOCKER group: DEBIAN DOCKER, Git Bash, Windows PowerShell, Git Bash 2");
      await page.getByRole("button", { name: "Target" }).hover();
      await expect.element(page.getByRole("tooltip")).toBeVisible();
      const rect = page.getByRole("tooltip").element().getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(8);
      expect(rect.right).toBeLessThanOrEqual(792);
      expect(rect.top).toBeGreaterThanOrEqual(8);
      expect(rect.bottom).toBeLessThanOrEqual(592);
    });
  }
  it("wraps unbroken names and dismisses keyboard help with Escape", async () => {
    await page.viewport(320, 240);
    mount("left", "a".repeat(1000));
    await expect.element(page.getByRole("button", { name: "Target" })).toBeVisible();
    await page.getByRole("button", { name: "Target" }).click();
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    const tooltip = page.getByRole("tooltip").element();
    expect(tooltip.scrollWidth).toBeLessThanOrEqual(304);
    expect(tooltip.getBoundingClientRect().bottom).toBeLessThanOrEqual(232);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  });
});
