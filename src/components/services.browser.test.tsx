import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { ConnectionSection } from "./ResizablePanels";
import { ServicesPane } from "../pages/ServicesPane";
import * as fixtures from "../test/app-fixtures";
import "../styles.css";

vi.mock("../lib/api", () => ({ api: { listServices: vi.fn() }, errorMessage: String }));
let root: Root;
let host: HTMLDivElement;
afterEach(() => {
  root?.unmount();
  host?.remove();
});

describe("Linux service scrolling with a refresh warning", () => {
  it.each([360, 500, 960])("keeps the service list usable in a %s px pane", async (width) => {
    await page.viewport(1000, 640);
    host = document.createElement("div");
    host.style.cssText = `position:relative;width:${width}px;height:558px`;
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <ConnectionSection section="services">
        <ServicesPane
          connection={fixtures.connection()}
          cache={{
            items: Array.from({ length: 100 }, (_, index) => ({
              ...fixtures.service,
              id: `service-${index}.service`,
            })),
            fetchedAt: Date.now(),
            loading: false,
            error: "Connection timed out",
          }}
          onCacheChange={() => undefined}
          onViewLogs={() => undefined}
        />
      </ConnectionSection>,
    );
    await expect
      .element(page.getByRole("button", { name: /service-99.service/ }))
      .toBeInTheDocument();
    const list = page.getByRole("region", { name: "Systemd units" });
    const rows = list.element();
    expect(rows.clientHeight).toBeGreaterThanOrEqual(52);
    await userEvent.wheel(list, { delta: { y: 500 } });
    await vi.waitFor(() => expect(rows.scrollTop).toBeGreaterThan(0));
    await expect.element(page.getByPlaceholder("Search units")).toBeVisible();
    rows.focus();
    await userEvent.keyboard("{End}");
    await vi.waitFor(() =>
      expect(rows.scrollTop + rows.clientHeight).toBeGreaterThanOrEqual(rows.scrollHeight - 1),
    );
    await page.getByRole("button", { name: /service-99.service/ }).click();
    expect(host.querySelector(".detail-panel h2")?.textContent).toBe("service-99.service");
  });
});
