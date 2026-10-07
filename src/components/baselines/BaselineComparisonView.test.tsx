// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseline, comparison } from "../../test/app-fixtures";

const native = vi.hoisted(() => ({ save: vi.fn(), exportTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("../../lib/api", () => ({
  api: { exportTextFile: native.exportTextFile },
  errorMessage: (error: Error) => error.message,
}));
import { BaselineComparisonView } from "./BaselineComparisonView";

beforeEach(() => {
  vi.resetAllMocks();
  native.save.mockResolvedValue("fixture-export");
  native.exportTextFile.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount() {
  const data = comparison(baseline("before"), baseline("after"));
  data.sections[0].kind = "systemdUnits";
  data.sections[0].changed = [
    {
      identity: "fixture.service",
      label: "fixture.service",
      changes: [
        { name: "kernel", baseValue: "6.8", targetValue: "6.9" },
        { name: "subState", baseValue: "running", targetValue: "exited" },
      ],
    },
  ];
  const onError = vi.fn();
  render(<BaselineComparisonView comparison={data} onError={onError} />);
  return onError;
}

describe("baseline exports through the save dialog", () => {
  for (const format of ["Markdown", "JSON"]) {
    it(`exports the displayed comparison as ${format}`, async () => {
      mount();
      await userEvent.click(screen.getByRole("button", { name: format }));
      await waitFor(() => expect(native.exportTextFile).toHaveBeenCalled());
      const [path, content] = native.exportTextFile.mock.calls[0];
      expect(path).toBe("fixture-export");
      expect(content).toContain("kernel");
      expect(content).toContain("6.9");
      expect(content).not.toContain("subState");
      if (format === "JSON")
        expect(JSON.parse(content).sections[0].changed[0].changes).toHaveLength(1);
      else expect(content).toContain("#");
    });
  }
  it("does not write after dialog cancellation", async () => {
    native.save.mockResolvedValue(null);
    mount();
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(native.save).toHaveBeenCalled());
    expect(native.exportTextFile).not.toHaveBeenCalled();
  });
  it("includes volatile values only when the user asks", async () => {
    mount();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Hide values that move on their own" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(native.exportTextFile).toHaveBeenCalled());
    expect(
      JSON.parse(native.exportTextFile.mock.calls[0][1]).sections[0].changed[0].changes,
    ).toHaveLength(2);
  });
  it("reports write failures and allows another export", async () => {
    native.exportTextFile.mockRejectedValueOnce(new Error("disk full"));
    const onError = mount();
    await userEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("disk full"));
    await userEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(native.exportTextFile).toHaveBeenCalledTimes(2));
  });
  it("reports save-dialog failure without writing", async () => {
    native.save.mockRejectedValue(new Error("dialog unavailable"));
    const onError = mount();
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dialog unavailable"));
    expect(native.exportTextFile).not.toHaveBeenCalled();
  });
});
