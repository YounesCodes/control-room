// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ effectiveSshConfiguration: vi.fn() }));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { EffectiveSshConfiguration, SavedConnection } from "../types";
import { SshConfigPane } from "./SshConfigPane";

const connection: SavedConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Host A",
  destination: "host-a",
  username: "root",
  port: 2222,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

const configuration: EffectiveSshConfiguration = {
  connectionId: connection.id,
  sshVersion: "OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2",
  exitStatus: 0,
  diagnostic: null,
  hostname: { value: "192.0.2.10", origin: "openSshResolved" },
  user: { value: "root", origin: "savedConnectionOverride" },
  port: { value: "2222", origin: "savedConnectionOverride" },
  addressFamily: { value: "any", origin: "openSshResolved" },
  identityFiles: [
    { value: "~/.ssh/id_ed25519", origin: "openSshResolved" },
    { value: "~/.ssh/id_rsa", origin: "openSshResolved" },
  ],
  identitiesOnly: { value: "no", origin: "openSshResolved" },
  proxyJump: { value: "bastion", origin: "openSshResolved" },
  proxyCommandConfigured: true,
  canonicalizeHostname: { value: "no", origin: "openSshResolved" },
  serverAliveInterval: { value: "30", origin: "openSshResolved" },
  serverAliveCountMax: { value: "3", origin: "openSshResolved" },
  tcpKeepAlive: { value: "yes", origin: "openSshResolved" },
  connectTimeout: { value: "none", origin: "openSshResolved" },
  parseLimitations: ["ProxyCommand is configured, but its command text is redacted."],
  collectedAt: "2026-08-31T12:00:00Z",
};

describe("SshConfigPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.effectiveSshConfiguration.mockResolvedValue(configuration);
  });
  afterEach(cleanup);

  it("renders typed fields, repeatable identities, origins, and redaction", async () => {
    render(<SshConfigPane connection={connection} />);

    expect(await screen.findByText("192.0.2.10")).toBeTruthy();
    expect(screen.getByText("~/.ssh/id_ed25519")).toBeTruthy();
    expect(screen.getByText("~/.ssh/id_rsa")).toBeTruthy();
    expect(screen.getByText("Configured — command text redacted")).toBeTruthy();
    expect(screen.getAllByText("Saved Connection override")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("secret-token");
    expect(screen.getByText(/does not connect to the host/)).toBeTruthy();
  });

  it("refreshes local inspection without persisting a result", async () => {
    const user = userEvent.setup();
    render(<SshConfigPane connection={connection} />);
    await screen.findByText("192.0.2.10");
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(api.effectiveSshConfiguration).toHaveBeenCalledTimes(2));
    expect(api.effectiveSshConfiguration).toHaveBeenLastCalledWith(connection.id);
  });

  it("shows sanitized inspection diagnostics and exit status", async () => {
    api.effectiveSshConfiguration.mockResolvedValue({
      ...configuration,
      exitStatus: 255,
      diagnostic: "OpenSSH could not parse the local configuration.",
      hostname: null,
    });
    render(<SshConfigPane connection={connection} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "OpenSSH could not parse the local configuration.",
    );
    expect(screen.getByText("255")).toBeTruthy();
    expect(screen.getByText("Not reported")).toBeTruthy();
  });
});
