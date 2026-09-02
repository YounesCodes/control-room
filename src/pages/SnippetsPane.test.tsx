// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listCommandSnippets: vi.fn(),
  saveCommandSnippet: vi.fn(),
  deleteCommandSnippet: vi.fn(),
  moveCommandSnippet: vi.fn(),
  renderCommandSnippet: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import type { CommandSnippet, SavedConnection, SnippetParameter } from "../types";
import { SnippetsPane } from "./SnippetsPane";

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

function parameter(overrides: Partial<SnippetParameter> = {}): SnippetParameter {
  return {
    name: "service",
    prompt: "Unit",
    kind: "string",
    required: true,
    choices: [],
    minimum: null,
    maximum: null,
    defaultValue: null,
    ...overrides,
  };
}

function snippet(overrides: Partial<CommandSnippet> = {}): CommandSnippet {
  return {
    id: "snippet-1",
    name: "Unit journal",
    template: "journalctl -u {{service}} -n {{lines}}",
    parameters: [
      parameter(),
      parameter({ name: "lines", prompt: "Lines", kind: "integer", defaultValue: "200" }),
    ],
    shell: "bash",
    connectionId: null,
    position: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function renderPane(canPaste = true) {
  const onPaste = vi.fn();
  render(<SnippetsPane connection={connection} onPaste={onPaste} canPaste={canPaste} />);
  return { onPaste };
}

beforeEach(() => {
  api.listCommandSnippets.mockResolvedValue([snippet()]);
  api.renderCommandSnippet.mockResolvedValue({
    command: "journalctl -u 'nginx.service' -n 200",
    errors: [],
    shell: "bash",
  });
  api.deleteCommandSnippet.mockResolvedValue(undefined);
  api.moveCommandSnippet.mockResolvedValue([snippet()]);
  api.saveCommandSnippet.mockResolvedValue(snippet());
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("snippets pane", () => {
  it("previews the command Rust rendered and inserts that same string", async () => {
    const { onPaste } = renderPane();
    expect(await screen.findByText("journalctl -u 'nginx.service' -n 200")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Insert into terminal/ }));
    expect(onPaste).toHaveBeenCalledWith("journalctl -u 'nginx.service' -n 200");
    expect(onPaste.mock.calls[0][0]).not.toContain("\n");
  });

  it("asks Rust to render on every value change and never substitutes locally", async () => {
    renderPane();
    await waitFor(() => expect(api.renderCommandSnippet).toHaveBeenCalled());
    await userEvent.clear(screen.getByLabelText(/Lines/));
    await userEvent.type(screen.getByLabelText(/Lines/), "50");
    await waitFor(() => {
      const last = api.renderCommandSnippet.mock.calls.at(-1);
      expect(last?.[1]).toEqual({ service: "", lines: "50" });
    });
    expect(api.renderCommandSnippet.mock.calls[0][0]).toBe("snippet-1");
  });

  it("starts each field from its author-set default", async () => {
    renderPane();
    await waitFor(() => expect(api.renderCommandSnippet).toHaveBeenCalled());
    expect(api.renderCommandSnippet.mock.calls[0][1]).toEqual({ service: "", lines: "200" });
  });

  it("shows no preview and blocks insertion when a value is not usable", async () => {
    api.renderCommandSnippet.mockResolvedValue({
      command: null,
      errors: [{ parameter: "lines", message: "Lines: enter 1 or more" }],
      shell: "bash",
    });
    renderPane();
    expect(await screen.findByText("Lines: enter 1 or more")).toBeTruthy();
    expect(screen.getByText("Fill in the values above to see the command.")).toBeTruthy();
    expect(button(/Insert into terminal/).disabled).toBe(true);
  });

  it("shows an error with no field of its own on its own line", async () => {
    api.renderCommandSnippet.mockResolvedValue({
      command: null,
      errors: [{ parameter: null, message: "The result is longer than 4000 characters" }],
      shell: "bash",
    });
    renderPane();
    expect(await screen.findByText("The result is longer than 4000 characters")).toBeTruthy();
  });

  it("says insertion needs a terminal session and blocks it without one", async () => {
    renderPane(false);
    expect(
      await screen.findByText("Reconnect the Terminal Session before inserting a command."),
    ).toBeTruthy();
    expect(button(/Insert into terminal/).disabled).toBe(true);
  });

  it("states that insertion appends no Enter", async () => {
    renderPane();
    const notices = await screen.findAllByText(
      "Insert puts this text at the terminal cursor without Enter. Nothing runs until you press it.",
    );
    expect(notices.length).toBeGreaterThan(0);
  });

  it("warns against storing credentials in a snippet", async () => {
    renderPane();
    expect(
      await screen.findByText(
        "Snippets are stored on this PC in plain text. Do not put passwords, keys, or tokens in one.",
      ),
    ).toBeTruthy();
  });

  it("offers a choice parameter as a fixed list", async () => {
    api.listCommandSnippets.mockResolvedValue([
      snippet({
        template: "journalctl {{mode}}",
        parameters: [
          parameter({
            name: "mode",
            prompt: "Mode",
            kind: "choice",
            choices: ["--follow", "--no-pager"],
          }),
        ],
      }),
    ]);
    renderPane();
    const select = (await screen.findByLabelText(/Mode/)) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "",
      "--follow",
      "--no-pager",
    ]);
  });

  it("saves a new snippet with its scope and reloads the list", async () => {
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    await userEvent.type(screen.getByLabelText("Name"), "Status");
    await userEvent.type(screen.getByLabelText(/Template/), "systemctl status");
    await userEvent.click(screen.getByRole("checkbox", { name: "Only for Web 01" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveCommandSnippet).toHaveBeenCalled());
    expect(api.saveCommandSnippet.mock.calls[0][0]).toEqual({
      id: null,
      name: "Status",
      template: "systemctl status",
      parameters: [],
      connectionId: "connection-a",
    });
    await waitFor(() => expect(api.listCommandSnippets).toHaveBeenCalledTimes(2));
  });

  it("keeps a refused snippet in the editor with the reason", async () => {
    api.saveCommandSnippet.mockRejectedValue(new Error("{{lines}} has no parameter definition"));
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    await userEvent.type(screen.getByLabelText("Name"), "Broken");
    await userEvent.type(screen.getByLabelText(/Template/), "journalctl -n ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("{{lines}} has no parameter definition")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
  });

  it("edits an existing snippet by id", async () => {
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Unit journal" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveCommandSnippet).toHaveBeenCalled());
    const sent = api.saveCommandSnippet.mock.calls[0][0];
    expect(sent.id).toBe("snippet-1");
    expect(sent.parameters).toHaveLength(2);
  });

  it("reorders and deletes through the typed commands", async () => {
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "Move Unit journal down" }));
    expect(api.moveCommandSnippet).toHaveBeenCalledWith("snippet-1", "down", "connection-a");
    await userEvent.click(screen.getByRole("button", { name: "Delete Unit journal" }));
    await waitFor(() => expect(api.deleteCommandSnippet).toHaveBeenCalledWith("snippet-1"));
  });

  it("stops at the parameter limit in the editor", async () => {
    renderPane();
    await userEvent.click(await screen.findByRole("button", { name: "New snippet" }));
    for (let index = 0; index < 8; index += 1) {
      await userEvent.click(screen.getByRole("button", { name: "Add parameter" }));
    }
    expect(button("Add parameter").disabled).toBe(true);
    expect(screen.getAllByText(/^Parameter \d$/)).toHaveLength(8);
  });
});
