// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  collectHostImages: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type {
  ContainerImageFact,
  DockerContainer,
  HostImageInventory,
  SavedConnection,
} from "../types";
import { ImagesPane } from "./ImagesPane";

function saved(id: string, displayName: string): SavedConnection {
  return {
    id,
    displayName,
    destination: id,
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
}

const anchor = saved("host-a", "Host A");
const other = saved("host-b", "Host B");
const third = saved("host-c", "Host C");

function container(overrides: Partial<DockerContainer> = {}): DockerContainer {
  return {
    id: "a".repeat(64),
    name: "shop-web-1",
    image: "example/web:latest",
    state: "running",
    status: "Up 2 hours",
    ports: "",
    createdAt: "",
    composeProject: "shop",
    composeService: "web",
    composeContainerNumber: 1,
    composeOneoff: false,
    ...overrides,
  };
}

function fact(overrides: Partial<ContainerImageFact> = {}): ContainerImageFact {
  return {
    container: container(),
    recordedReference: "example/web:latest",
    imageId: "sha256:1111111111111111",
    repoDigests: ["sha256:aaaaaaaaaaaaaaaa"],
    ...overrides,
  };
}

function inventory(
  connectionId: string,
  containers: ContainerImageFact[],
  overrides: Partial<HostImageInventory> = {},
): HostImageInventory {
  return {
    connectionId,
    collectedAt: "2026-09-02T10:00:00Z",
    containers,
    inspectedContainers: containers.length,
    truncated: false,
    identityComplete: true,
    digestEvidenceAvailable: true,
    identityError: null,
    ...overrides,
  };
}

function renderPane(selected: string[] = ["host-b"], connections = [anchor, other, third]) {
  const onSelectedConnectionIdsChange = vi.fn();
  render(
    <ImagesPane
      connection={anchor}
      connections={connections}
      selectedConnectionIds={selected}
      onSelectedConnectionIdsChange={onSelectedConnectionIdsChange}
    />,
  );
  return { onSelectedConnectionIdsChange };
}

function checkbox(name: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

async function readHosts() {
  await userEvent.click(screen.getByRole("button", { name: "Read selected hosts" }));
}

beforeEach(() => {
  api.collectHostImages.mockImplementation((connectionId: string) =>
    Promise.resolve(inventory(connectionId, [fact()])),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("images pane", () => {
  it("reads the anchor host and each selected host once", async () => {
    renderPane();
    await readHosts();
    await waitFor(() => expect(api.collectHostImages).toHaveBeenCalledTimes(2));
    expect(api.collectHostImages.mock.calls.map((call) => call[0]).sort()).toEqual([
      "host-a",
      "host-b",
    ]);
    expect(screen.getAllByText("collected")).toHaveLength(2);
  });

  it("shows no comparison until the user confirms the match", async () => {
    renderPane();
    await readHosts();
    expect(await screen.findByText("shop/web")).toBeTruthy();
    expect(screen.queryByText("Same image")).toBeNull();
    expect(
      screen.getByText(/Compose project and service alone do not prove two containers/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Match confirmed" }));
    expect(screen.getByText("Same image")).toBeTruthy();
    expect(screen.getByText("Same image across 2 of 2 hosts")).toBeTruthy();
  });

  it("does not let a host it could not read look like agreement", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      connectionId === "host-b"
        ? Promise.reject(new Error("Permission denied: docker"))
        : Promise.resolve(inventory(connectionId, [fact()])),
    );
    renderPane();
    await readHosts();
    expect(await screen.findByText("Permission denied: docker")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Match confirmed" }));
    expect(screen.getByText("Not comparable")).toBeTruthy();
    expect(screen.getByText("Not comparable: 1 of 2 hosts had comparable evidence")).toBeTruthy();
  });

  it("offers sudo for a permission failure and retries that host alone", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      connectionId === "host-b"
        ? Promise.reject(new Error("Permission denied: docker"))
        : Promise.resolve(inventory(connectionId, [fact()])),
    );
    renderPane();
    await readHosts();
    await waitFor(() => expect(api.collectHostImages).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Retry with sudo" }));
    await userEvent.type(screen.getByLabelText(/Password/), "secret");
    api.collectHostImages.mockResolvedValue(inventory("host-b", [fact()]));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.collectHostImages).toHaveBeenCalledTimes(3));
    expect(api.collectHostImages.mock.calls[2]).toEqual(["host-b", "secret"]);
  });

  it("marks a mutable tag that hides two different images", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      Promise.resolve(
        inventory(connectionId, [
          fact(
            connectionId === "host-b"
              ? { imageId: "sha256:2222222222222222", repoDigests: [] }
              : {},
          ),
        ]),
      ),
    );
    renderPane();
    await readHosts();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Match confirmed" }));
    expect(screen.getByText("Same tag, different image")).toBeTruthy();
    expect(
      screen.getByText("No registry digest on at least one host, so digests were not compared"),
    ).toBeTruthy();
  });

  it("asks which instance to compare when a service is scaled", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      Promise.resolve(
        connectionId === "host-a"
          ? inventory(connectionId, [
              fact({ container: container({ id: "b".repeat(64), name: "shop-web-1" }) }),
              fact({
                container: container({
                  id: "c".repeat(64),
                  name: "shop-web-2",
                  composeContainerNumber: 2,
                }),
              }),
            ])
          : inventory(connectionId, [fact()]),
      ),
    );
    renderPane();
    await readHosts();
    expect(await screen.findByText("2 candidates, pick one")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Match confirmed" }));
    expect(screen.getByText("Not comparable")).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByLabelText("Instance for shop/web on Host A"),
      "c".repeat(64),
    );
    expect(screen.getByText("Same image")).toBeTruthy();
  });

  it("leaves confirm-all alone for an ambiguous workload", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      Promise.resolve(
        inventory(connectionId, [
          fact({ container: container({ id: "b".repeat(64), name: "shop-web-1" }) }),
          fact({
            container: container({
              id: "c".repeat(64),
              name: "shop-web-2",
              composeContainerNumber: 2,
            }),
          }),
        ]),
      ),
    );
    renderPane();
    await readHosts();
    await userEvent.click(
      await screen.findByRole("button", { name: "Confirm all unambiguous matches" }),
    );
    expect(screen.queryByText("Same image")).toBeNull();
    expect(checkbox("Match confirmed").checked).toBe(false);
  });

  it("lists containers it cannot pair instead of guessing from their names", async () => {
    api.collectHostImages.mockImplementation((connectionId: string) =>
      Promise.resolve(
        inventory(connectionId, [
          fact({
            container: container({
              composeProject: null,
              composeService: null,
              name: "legacy-web",
            }),
          }),
        ]),
      ),
    );
    renderPane();
    await readHosts();
    expect(await screen.findByText("Not paired")).toBeTruthy();
    expect(screen.getByText("Host A: legacy-web")).toBeTruthy();
    expect(
      screen.getByText(/leaves them unpaired instead of guessing from their names/),
    ).toBeTruthy();
  });

  it("keeps the host count bounded", async () => {
    const many = Array.from({ length: 8 }, (_, index) => saved(`host-${index}`, `Host ${index}`));
    renderPane(
      many.slice(0, 5).map((entry) => entry.id),
      [anchor, ...many],
    );
    // Five chosen hosts plus the anchor fills the bound, so an unchosen host
    // cannot be added.
    expect(checkbox("Host 6").disabled).toBe(true);
    expect(checkbox("Host 0").checked).toBe(true);
    expect(screen.getByText("At most 6 hosts in one comparison.")).toBeTruthy();
  });

  it("says plainly that it changes nothing", () => {
    renderPane();
    expect(
      screen.getByText(
        /Matches are suggested, never applied on your behalf, and Control Room changes no image or container/,
      ),
    ).toBeTruthy();
  });
});
