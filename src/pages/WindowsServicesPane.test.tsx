// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedConnection } from "../types";
const listWindowsServices = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { listWindowsServices }, errorMessage: String }));
import { WindowsServicesPane } from "./WindowsServicesPane";
const services = [
  {
    id: "sshd",
    displayName: "OpenSSH SSH Server",
    description: "SSH server",
    state: "running",
    startMode: "Auto",
    processId: 123,
  },
  {
    id: "fixture",
    displayName: "Fixture service",
    description: null,
    state: "stopped",
    startMode: "Manual",
    processId: null,
  },
];
beforeEach(() => listWindowsServices.mockReset().mockResolvedValue(services));
afterEach(cleanup);
describe("Windows service inventory", () => {
  it("filters services and shows real Windows state and startup details", async () => {
    render(<WindowsServicesPane connection={{ id: "windows-host" } as SavedConnection} />);
    await screen.findByText("1 running / 2 total");
    await userEvent.click(screen.getByRole("button", { name: /OpenSSH SSH Server/ }));
    expect(screen.getByText("Auto")).toBeTruthy();
    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.queryByText("Systemd")).toBeNull();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Filter service state" }),
      "stopped",
    );
    expect(screen.queryByRole("button", { name: /OpenSSH SSH Server/ })).toBeNull();
    expect(screen.getByText("Selected service is outside this filter")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Fixture service/ }));
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText("Not running")).toBeTruthy();
  });
  it("preserves previous rows when a refresh fails and allows recovery", async () => {
    render(<WindowsServicesPane connection={{ id: "windows-host" } as SavedConnection} />);
    await screen.findByText("1 running / 2 total");
    listWindowsServices.mockRejectedValueOnce("Windows access denied");
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/Showing previous services/);
    expect(screen.getByRole("button", { name: /OpenSSH SSH Server/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText(/Showing previous services/)).toBeNull());
  });
});
