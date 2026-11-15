// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listServices: vi.fn() }));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { CachedList, SavedConnection, SystemdUnit } from "../types";
import { LaunchdServicesPane } from "./LaunchdServicesPane";

const connection: SavedConnection = {
  id: "connection-mac",
  displayName: "Mac",
  destination: "mac",
  username: "user",
  port: null,
  identityFile: null,
  historyEnabled: false,
  sudoEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

function unit(id: string, unitType: string, activeState: string, subState: string): SystemdUnit {
  return {
    id,
    unitType,
    description: `${id} description`,
    loadState: "loaded",
    activeState,
    subState,
    unitFileState: null,
  };
}

function cache(items: SystemdUnit[]): CachedList<SystemdUnit> {
  return { items, fetchedAt: Date.now(), loading: false, error: null };
}

afterEach(cleanup);

describe("LaunchdServicesPane", () => {
  it("uses launchd daemon and agent filters and routes service logs", async () => {
    const onViewLogs = vi.fn();
    render(
      <LaunchdServicesPane
        connection={connection}
        cache={cache([
          unit("system/com.example.daemon", "daemon", "active", "running (PID 42)"),
          unit("gui/501/com.example.agent", "agent", "inactive", "waiting"),
        ])}
        onCacheChange={vi.fn()}
        onViewLogs={onViewLogs}
      />,
    );
    expect(screen.getByRole("heading", { name: "Services" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Service type"), "agent");
    expect(screen.queryByRole("button", { name: /system\/com.example.daemon/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /gui\/501\/com.example.agent/ }));
    expect(screen.queryByText("Unit-file state")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "View logs" }));
    expect(onViewLogs).toHaveBeenCalledWith({ type: "systemd", id: "gui/501/com.example.agent" });
    expect(api.listServices).not.toHaveBeenCalled();
  });
});
