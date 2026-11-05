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

function mount(showRoutine = false, search = "") {
  const data = comparison(baseline("before"), baseline("after"));
  data.sections[0].kind = "systemdUnits";
  data.sections[0].routineCount = 1;
  data.sections[0].changed = [
    {
      identity: "fixture.service",
      label: "fixture.service",
      changes: [
        {
          name: "unitFileState",
          baseValue: "enabled",
          targetValue: "disabled",
          classification: "meaningful",
          reason: null,
        },
        {
          name: "subState",
          baseValue: "running",
          targetValue: "exited",
          classification: "routine",
          reason: "Sub-states move on their own between captures.",
        },
      ],
    },
  ];
  const onError = vi.fn();
  const onShowRoutineChange = vi.fn();
  render(
    <BaselineComparisonView
      comparison={data}
      showRoutine={showRoutine}
      search={search}
      selectedIdentity={null}
      onShowRoutineChange={onShowRoutineChange}
      onInspectEntry={vi.fn()}
      onInspectChange={vi.fn()}
      onError={onError}
      compact={false}
    />,
  );
  return { onError, onShowRoutineChange };
}

describe("baseline exports through the save dialog", () => {
  for (const format of ["Markdown", "JSON"]) {
    it(`exports the displayed comparison as ${format}`, async () => {
      mount(true);
      await userEvent.click(screen.getByRole("button", { name: format }));
      await waitFor(() => expect(native.exportTextFile).toHaveBeenCalled());
      const [path, content] = native.exportTextFile.mock.calls[0];
      expect(path).toBe("fixture-export");
      expect(content).toContain("fixture.service");
      if (format === "JSON") {
        const parsed = JSON.parse(content);
        expect(parsed.sections[0].changed[0].changes).toHaveLength(2);
      } else {
        expect(content).toContain("unitFileState");
      }
    });
  }

  it("omits routine facts from the markdown the screen shows, and says how many are hidden", async () => {
    mount(false);
    await userEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(native.exportTextFile).toHaveBeenCalled());
    const content = native.exportTextFile.mock.calls[0][1];
    expect(content).toContain("1 routine change hidden");
    expect(content).toContain("unitFileState: `enabled` → `disabled`");
    expect(content).not.toContain("subState: `running`");
  });
  it("offers to reveal routine changes rather than deleting them", async () => {
    const { onShowRoutineChange } = mount(false);
    expect(screen.queryByText("fixture.service", { exact: false })).toBeTruthy();
    expect(screen.getByText(/1 routine change hidden/)).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Show routine changes" }));
    expect(onShowRoutineChange).toHaveBeenCalledWith(true);
  });

  it("does not write after dialog cancellation", async () => {
    native.save.mockResolvedValue(null);
    mount(true);
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(native.save).toHaveBeenCalled());
    expect(native.exportTextFile).not.toHaveBeenCalled();
  });

  it("reports write failures and allows another export", async () => {
    native.exportTextFile.mockRejectedValueOnce(new Error("disk full"));
    const { onError } = mount(true);
    await userEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("disk full"));
    await userEvent.click(screen.getByRole("button", { name: "Markdown" }));
    await waitFor(() => expect(native.exportTextFile).toHaveBeenCalledTimes(2));
  });

  it("reports save-dialog failure without writing", async () => {
    native.save.mockRejectedValue(new Error("dialog unavailable"));
    const { onError } = mount(true);
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("dialog unavailable"));
    expect(native.exportTextFile).not.toHaveBeenCalled();
  });

  it("shows unverified removals as such instead of confidently gone", () => {
    const data = comparison(baseline("before"), baseline("after"));
    data.sections[0].kind = "listeners";
    data.sections[0].removalsIndeterminate = true;
    data.sections[0].removed = [
      { identity: "tcp/ipv4/0.0.0.0:22", label: "0.0.0.0:22/tcp", facts: [] },
    ];
    render(
      <BaselineComparisonView
        comparison={data}
        showRoutine={false}
        search=""
        selectedIdentity={null}
        onShowRoutineChange={vi.fn()}
        onInspectEntry={vi.fn()}
        onInspectChange={vi.fn()}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByText(/removals here are unverified, not confirmed gone/i)).toBeTruthy();
  });
});
