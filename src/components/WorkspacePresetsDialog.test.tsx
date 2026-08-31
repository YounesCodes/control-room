// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCapabilities, SavedConnection, WorkspacePreset } from "../types";
import { WorkspacePresetsDialog } from "./WorkspacePresetsDialog";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Host A",
  destination: "host-a",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const preset: WorkspacePreset = {
  id: "preset-a",
  name: "Web investigation",
  schemaVersion: 1,
  views: [
    {
      key: "11111111-1111-4111-8111-111111111111",
      label: "Web container",
      view: "docker",
      selector: { kind: "dockerContainer", container: "web" },
    },
  ],
  layout: null,
  createdAt: "now",
  updatedAt: "now",
};

const capabilities: HostCapabilities = {
  connectionId: connection.id,
  hostname: "host-a",
  osId: "debian",
  osName: "Debian",
  osVersion: "13",
  kernel: "6",
  architecture: "x86_64",
  uptime: null,
  defaultShell: "/bin/bash",
  systemdAvailable: true,
  journaldAvailable: true,
  dockerAvailable: false,
  dockerAccessible: false,
  dockerVersion: null,
  runningServiceCount: null,
  runningContainerCount: null,
  totalContainerCount: null,
  detectedAt: "now",
};

describe("WorkspacePresetsDialog", () => {
  afterEach(cleanup);

  it("previews compatibility and exposes every local preset lifecycle action", async () => {
    const user = userEvent.setup();
    const onCreateFromCurrent = vi.fn().mockResolvedValue(undefined);
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const onApply = vi.fn();
    render(
      <WorkspacePresetsDialog
        presets={[preset]}
        connections={[connection]}
        currentConnectionId={connection.id}
        currentViewCount={2}
        capabilities={{ [connection.id]: capabilities }}
        onCreateFromCurrent={onCreateFromCurrent}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/Docker was not detected/i)).toBeTruthy();
    expect(screen.getByText(/1 view is unsupported/i)).toBeTruthy();

    await user.type(screen.getByLabelText("Preset name"), "Current layout");
    await user.click(screen.getByRole("button", { name: /Save current layout/i }));
    expect(onCreateFromCurrent).toHaveBeenCalledWith("Current layout");

    await user.click(screen.getByLabelText("Rename Web investigation"));
    const rename = screen.getByLabelText("Rename Web investigation");
    await user.clear(rename);
    await user.type(rename, "Renamed preset");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdate).toHaveBeenCalledWith(
      preset.id,
      expect.objectContaining({ name: "Renamed preset" }),
    );

    await user.click(screen.getByLabelText("Duplicate Web investigation"));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: "Web investigation copy",
      views: [expect.objectContaining({ selector: preset.views[0].selector })],
    });

    await user.click(screen.getByLabelText("Delete Web investigation"));
    await user.click(screen.getByLabelText("Confirm delete Web investigation"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(preset.id));

    await user.click(screen.getByRole("button", { name: "Apply disconnected" }));
    expect(onApply).toHaveBeenCalledWith(preset, connection);
  });
});
