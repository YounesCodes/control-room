import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import axe from "axe-core";
import { FontCatalogPicker } from "./FontCatalogPicker";
import previewUrl from "../assets/fonts/space-grotesk-latin.woff2?url";
import "../styles.css";

vi.mock("../lib/api", () => ({
  api: {
    listCatalogFonts: async () => ({
      fonts: [
        { id: "fira-mono", family: "Fira Mono", license: "OFL-1.1" },
        { id: "jetbrains-mono", family: "JetBrains Mono", license: "OFL-1.1" },
      ],
      stale: false,
    }),
    previewCatalogFont: async () => (await fetch(previewUrl)).arrayBuffer(),
    installCatalogFont: vi.fn(),
  },
  errorMessage: String,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  root?.unmount();
  container?.remove();
});
function Fixture() {
  const [family, setFamily] = useState<string | null>(null);
  return (
    <section className="feature-page settings-page">
      <form className="settings-form" onSubmit={(e) => e.preventDefault()}>
        <fieldset>
          <legend>Terminal font</legend>
          <FontCatalogPicker onPreview={setFamily} onBusyChange={() => {}} onUse={async () => {}} />
          <div
            className="ansi-preview"
            style={{ fontFamily: family ?? "Consolas, monospace" }}
            aria-label="Terminal font preview"
          >
            user@host:~$ echo 0O1Il
          </div>
        </fieldset>
      </form>
    </section>
  );
}

it("renders temporary faces, supports keyboard selection, and passes accessibility at minimum width", async () => {
  await page.viewport(960, 640);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(<Fixture />);
  const input = page.getByRole("combobox", { name: "Search free fonts" });
  await input.click();
  await expect.element(page.getByRole("option", { name: /Fira Mono/ })).toBeVisible();
  await vi.waitFor(() =>
    expect(document.querySelector(".ansi-preview")?.getAttribute("style")).toContain(
      "ControlRoomPreview-fira-mono",
    ),
  );
  expect(document.fonts.check('14px "ControlRoomPreview-fira-mono"')).toBe(true);
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("option", { name: /JetBrains Mono/ }))
    .toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() =>
    expect(document.querySelector(".ansi-preview")?.getAttribute("style")).toContain(
      "ControlRoomPreview-jetbrains-mono",
    ),
  );
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  });
  expect(
    result.violations.map(
      (item) => `${item.id}: ${item.nodes.map((node) => node.failureSummary).join("; ")}`,
    ),
  ).toEqual([]);
  expect(container.scrollWidth).toBeLessThanOrEqual(960);
  await page.screenshot({ path: "../../test-results/font-catalog.png" });
  await input.fill("jet");
  await expect.element(page.getByRole("option", { name: /Fira Mono/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  expect(document.querySelector(".ansi-preview")?.getAttribute("style")).toContain("Consolas");
  root.unmount();
  root = null;
  expect([...document.fonts].some((face) => face.family.startsWith("ControlRoomPreview-"))).toBe(
    false,
  );
});
