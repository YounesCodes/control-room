// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  resolveSshRoute: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { RouteSegment, SavedConnection, SshRoute } from "../types";
import { RoutePane } from "./RoutePane";

const connection: SavedConnection = {
  id: "connection-a",
  displayName: "Web 01",
  destination: "web-01",
  username: "deploy",
  port: null,
  identityFile: null,
  historyEnabled: false,
  groupId: null,
  tags: [],
  createdAt: "",
  updatedAt: "",
  lastConnectedAt: null,
};

function segment(overrides: Partial<RouteSegment> = {}): RouteSegment {
  return {
    kind: "destination",
    status: "resolved",
    alias: "web-01",
    hostname: "web-01.internal",
    user: "deploy",
    port: 22,
    identityFiles: [],
    proxyProgram: null,
    note: null,
    ...overrides,
  };
}

const origin = segment({
  kind: "origin",
  alias: "This PC",
  hostname: null,
  user: null,
  port: null,
});

function route(segments: RouteSegment[], overrides: Partial<SshRoute> = {}): SshRoute {
  return {
    connectionId: connection.id,
    resolvedAt: "2026-09-02T10:00:00.000Z",
    status: "resolved",
    segments,
    truncated: false,
    note: null,
    ...overrides,
  };
}

beforeEach(() => {
  api.resolveSshRoute.mockResolvedValue(
    route([
      origin,
      segment({ kind: "jump", alias: "bastion", hostname: "bastion.example" }),
      segment(),
    ]),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("route pane", () => {
  it("shows every segment from this PC to the destination", async () => {
    render(<RoutePane connection={connection} />);
    await waitFor(() => expect(api.resolveSshRoute).toHaveBeenCalledWith("connection-a"));
    expect(await screen.findByText("This PC")).toBeTruthy();
    expect(screen.getByText("bastion")).toBeTruthy();
    expect(screen.getByText("alias for bastion.example")).toBeTruthy();
    expect(screen.getByText("deploy@web-01.internal:22")).toBeTruthy();
    expect(screen.getByText("1 jump host between this PC and the destination")).toBeTruthy();
  });

  it("says it contacted nothing", async () => {
    render(<RoutePane connection={connection} />);
    expect(
      await screen.findByText(
        "Read from the installed OpenSSH client. No host is contacted and no key is read.",
      ),
    ).toBeTruthy();
  });

  it("reports an opaque proxy command without showing its arguments", async () => {
    api.resolveSshRoute.mockResolvedValue(
      route(
        [
          origin,
          segment({
            status: "opaqueProxy",
            proxyProgram: "connect.exe",
            note: "Custom proxy command, route not safely interpretable",
          }),
        ],
        { status: "partial" },
      ),
    );
    render(<RoutePane connection={connection} />);
    expect(
      await screen.findByText("Custom proxy command, route not safely interpretable"),
    ).toBeTruthy();
    expect(screen.getByText("not interpretable")).toBeTruthy();
    expect(
      screen.getByText("Proxy program: connect.exe. Its arguments are not shown."),
    ).toBeTruthy();
    expect(screen.getByText(/Part of this route could not be interpreted/)).toBeTruthy();
  });

  it("keeps a loop segment in place instead of shortening the route", async () => {
    api.resolveSshRoute.mockResolvedValue(
      route(
        [
          origin,
          segment({
            kind: "jump",
            alias: "bastion",
            status: "loop",
            hostname: null,
            note: "This host was already on the route. Control Room stopped rather than follow the loop.",
          }),
          segment(),
        ],
        { status: "partial" },
      ),
    );
    render(<RoutePane connection={connection} />);
    expect(await screen.findByText("loop")).toBeTruthy();
    expect(screen.getByText(/stopped rather than follow the loop/)).toBeTruthy();
    expect(screen.getByText("bastion")).toBeTruthy();
  });

  it("says when the route was longer than it follows", async () => {
    api.resolveSshRoute.mockResolvedValue(
      route([origin, segment({ status: "limit" })], { status: "partial", truncated: true }),
    );
    render(<RoutePane connection={connection} />);
    expect(
      await screen.findByText(
        "This route was longer than Control Room follows. The end of it is not shown.",
      ),
    ).toBeTruthy();
  });

  it("lists identity files by path", async () => {
    api.resolveSshRoute.mockResolvedValue(
      route([origin, segment({ identityFiles: ["C:\\keys\\id_ed25519"] })]),
    );
    render(<RoutePane connection={connection} />);
    expect(await screen.findByText("C:\\keys\\id_ed25519")).toBeTruthy();
    expect(screen.getByText("Identity file")).toBeTruthy();
  });

  it("offers a retry when the client could not be read", async () => {
    api.resolveSshRoute.mockRejectedValueOnce(
      new Error("The Windows OpenSSH client was not found on this PC"),
    );
    render(<RoutePane connection={connection} />);
    expect(
      await screen.findByText("The Windows OpenSSH client was not found on this PC"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.resolveSshRoute).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("This PC")).toBeTruthy();
  });

  it("names the fields OpenSSH reported nothing for", async () => {
    api.resolveSshRoute.mockResolvedValue(
      route([origin, segment({ user: null, port: null, hostname: null, status: "unresolved" })]),
    );
    render(<RoutePane connection={connection} />);
    expect(await screen.findByText("OpenSSH reported no user, port, hostname")).toBeTruthy();
  });
});
