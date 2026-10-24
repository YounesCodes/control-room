// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
  it("skips hidden controls, disabled fieldsets, and unselected radio options", async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Choose" onClose={vi.fn()}>
        <button>First</button>
        <fieldset disabled>
          <input aria-label="Disabled field" />
        </fieldset>
        <div hidden>
          <button>Hidden</button>
        </div>
        <div style={{ display: "none" }}>
          <button>Collapsed</button>
        </div>
        <input type="radio" name="choice" aria-label="Other choice" />
        <input type="radio" name="choice" aria-label="Selected choice" defaultChecked />
        <button>Last</button>
      </Modal>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Selected choice" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });
  it("focuses the first task control instead of the close button", () => {
    render(
      <Modal title="Edit group" onClose={vi.fn()}>
        <button type="button">Rename group</button>
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename group" }));
  });

  it("keeps keyboard focus inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <Modal title="Edit group" onClose={vi.fn()}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>,
    );

    screen.getByRole("button", { name: "Last action" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First action" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last action" }));
  });
});
