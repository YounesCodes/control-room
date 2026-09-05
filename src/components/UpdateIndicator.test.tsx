// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateIndicator } from "./UpdateIndicator";
import { WhatsNewDialog } from "./WhatsNewDialog";
import type { AppUpdateState } from "../lib/app-update";
import type { AppUpdateInfo } from "../types";

const info: AppUpdateInfo = {
  currentVersion: "0.6.1",
  version: "0.7.0",
  notes: "## Added\n- Local terminals\n\n## Fixed\n- A crash",
  publishedAt: "2026-09-05T17:00:00Z",
};

function renderIndicator(state: AppUpdateState) {
  const onDownload = vi.fn();
  const onRestart = vi.fn();
  render(<UpdateIndicator state={state} onDownload={onDownload} onRestart={onRestart} />);
  return { onDownload, onRestart };
}

describe("titlebar update indicator", () => {
  afterEach(cleanup);

  it("renders nothing at all when Control Room is current", () => {
    const { container } = render(
      <UpdateIndicator state={{ status: "idle" }} onDownload={vi.fn()} onRestart={vi.fn()} />,
    );
    // Not a hidden node, not an empty wrapper: an up-to-date titlebar is the
    // titlebar that existed before this feature.
    expect(container.innerHTML).toBe("");
  });

  it("stays silent while a check is in flight", () => {
    const { container } = render(
      <UpdateIndicator state={{ status: "checking" }} onDownload={vi.fn()} onRestart={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("offers the update with a version in its accessible name", () => {
    renderIndicator({ status: "available", info });
    const button = screen.getByRole("button", { name: "Update available: Control Room 0.7.0" });
    expect(button.textContent).toContain("Update available");
    // The control must not participate in window dragging.
    expect(button.closest("[data-tauri-drag-region]")).toBeNull();
  });

  it("shows download progress and exposes it as a progressbar", () => {
    renderIndicator({ status: "downloading", info, downloaded: 420, total: 1000 });
    expect(screen.getByRole("button", { name: /Downloading/ }).textContent).toContain(
      "Downloading 42%",
    );
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("42");
  });

  it("reports an unknown download size without a fake percentage", () => {
    renderIndicator({ status: "downloading", info, downloaded: 4200, total: null });
    expect(screen.getByRole("button", { name: /Downloading/ }).textContent).toContain(
      "Downloading…",
    );
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
    expect(progress.getAttribute("aria-valuetext")).toBe("Downloading, size unknown");
  });

  it("asks for a restart once the update is downloaded", async () => {
    const user = userEvent.setup();
    const { onRestart } = renderIndicator({ status: "downloaded", info });
    await user.click(screen.getByRole("button", { name: /Restart to update/ }));
    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("shows version and notes in the panel and downloads only when asked", async () => {
    const user = userEvent.setup();
    const { onDownload, onRestart } = renderIndicator({ status: "available", info });

    await user.click(screen.getByRole("button", { name: /Update available/ }));
    const panel = screen.getByRole("dialog", { name: "Control Room 0.7.0" });
    expect(within(panel).getByText("Control Room v0.7.0")).toBeTruthy();
    expect(within(panel).getByText("You have v0.6.1")).toBeTruthy();
    expect(within(panel).getByText("Local terminals")).toBeTruthy();
    expect(within(panel).getByText("Added")).toBeTruthy();

    // Opening the details must not have started anything.
    expect(onDownload).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole("button", { name: /Download update/ }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("closes the panel on Later without acting", async () => {
    const user = userEvent.setup();
    const { onDownload } = renderIndicator({ status: "available", info });
    await user.click(screen.getByRole("button", { name: /Update available/ }));
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("never executes HTML from release notes", async () => {
    const user = userEvent.setup();
    renderIndicator({
      status: "available",
      info: { ...info, notes: '- <img src=x onerror="window.__pwned = true">' },
    });
    await user.click(screen.getByRole("button", { name: /Update available/ }));
    const panel = screen.getByRole("dialog");

    // The tag is present as text, and no element was created from it.
    expect(within(panel).getByText('<img src=x onerror="window.__pwned = true">')).toBeTruthy();
    expect(panel.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("says so plainly when a release has no notes", async () => {
    const user = userEvent.setup();
    renderIndicator({ status: "available", info: { ...info, notes: null } });
    await user.click(screen.getByRole("button", { name: /Update available/ }));
    expect(screen.getByText("This release has no notes.")).toBeTruthy();
  });

  it("reports a signature failure as a hard failure with no way past it", async () => {
    const user = userEvent.setup();
    renderIndicator({
      status: "failed",
      info,
      failure: { kind: "signature", message: "The update signature did not verify." },
    });
    await user.click(screen.getByRole("button", { name: /Update available/ }));
    const panel = screen.getByRole("dialog");
    expect(
      within(panel).getByText("The update signature did not verify, so it was not installed."),
    ).toBeTruthy();
    // Retrying the download is allowed; installing the rejected bytes is not
    // offered anywhere.
    expect(within(panel).queryByRole("button", { name: /install/i })).toBeNull();
    expect(within(panel).getByRole("button", { name: /Try again/ })).toBeTruthy();
  });
});

describe("what's new dialog", () => {
  afterEach(cleanup);

  it("titles itself with the installed version and renders notes as text", () => {
    render(
      <WhatsNewDialog
        notice={{ version: "0.7.0", notes: "## Fixed\n- <b>a crash</b>", publishedAt: null }}
        onDismiss={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "What's new in v0.7.0" });
    expect(within(dialog).getByText("Fixed")).toBeTruthy();
    expect(within(dialog).getByText("<b>a crash</b>")).toBeTruthy();
    expect(dialog.querySelector("b")).toBeNull();
  });

  it("states the fact it knows when a release has no notes", () => {
    render(
      <WhatsNewDialog
        notice={{ version: "0.7.0", notes: null, publishedAt: null }}
        onDismiss={vi.fn()}
      />,
    );
    // Never "nothing changed": that would be a claim about a release Control
    // Room cannot read.
    expect(screen.getByText("Control Room was updated to v0.7.0.")).toBeTruthy();
  });

  it("is dismissible by keyboard and reports the dismissal once", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <WhatsNewDialog
        notice={{ version: "0.7.0", notes: "- a note", publishedAt: null }}
        onDismiss={onDismiss}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("takes focus so it can be used without a mouse", () => {
    render(
      <WhatsNewDialog
        notice={{ version: "0.7.0", notes: "- a note", publishedAt: null }}
        onDismiss={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
