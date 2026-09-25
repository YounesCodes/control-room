// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

afterEach(cleanup);

describe("Modal", () => {
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
  });
});
