// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FilesPane } from "./FilesPane";
import { connection } from "../test/app-fixtures";
import { fileDropTarget } from "../hooks/use-file-drop";
import { clearFinished, fileJobs } from "../lib/file-transfers";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = null;
  },
}));
const host = connection();
afterEach(() => {
  cleanup();
  clearFinished(host);
  invoke.mockReset();
  vi.unstubAllGlobals();
});

async function editPath(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit path" }));
  return screen.findByRole<HTMLInputElement>("combobox", { name: "Remote folder path" });
}

it("opens a typed path and keeps the listed folder when navigation fails", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    if (args.folder === "/missing") throw new Error("Path not found on the host");
    return {
      path: args.folder === null ? "/home/fixture" : "/srv/shared reports",
      entries: [],
    };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const path = await editPath(user);
  expect(path.value).toBe("/home/fixture");
  expect(document.activeElement).toBe(path);
  await user.clear(path);
  await user.paste("/srv/shared reports/");
  expect(screen.getByRole("button", { name: "Upload files" })).toHaveProperty("disabled", true);
  await user.keyboard("{Enter}");
  await screen.findByText("shared reports");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit path" }));
  expect(invoke).toHaveBeenCalledWith("list_transfer_folder", {
    connectionId: host.id,
    folder: "/srv/shared reports/",
  });
  const missing = await editPath(user);
  await user.clear(missing);
  await user.paste("/missing");
  await user.keyboard("{Enter}");
  expect((await screen.findByRole("alert")).textContent).toContain("Path not found");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.getByText("shared reports").getAttribute("aria-current")).toBe("location");
  expect(screen.getByText("This folder is empty")).toBeTruthy();
  const discard = await editPath(user);
  await user.clear(discard);
  await user.paste("/discard");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("shared reports").getAttribute("aria-current")).toBe("location");
  expect(invoke.mock.calls.some(([, args]) => args.folder === "/discard")).toBe(false);
});

it("opens an ancestor from the breadcrumbs and hides retry for permission errors", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    if (args.folder === "/C:/Users/private")
      throw { permissionDenied: true, message: "Permission denied on the host" };
    return {
      path: args.folder ?? "/C:/Users/fixture",
      entries: [{ name: "private", kind: "folder", size: null }],
    };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  await user.click(await screen.findByRole("button", { name: "Open /C:/Users" }));
  await waitFor(() =>
    expect(screen.getByText("Users").getAttribute("aria-current")).toBe("location"),
  );
  expect(screen.getByRole("button", { name: "Open /C:/" })).toBeTruthy();
  expect(screen.getAllByRole("searchbox")).toHaveLength(1);
  expect(screen.queryByRole("combobox")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open folder private" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Permission denied on the host");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByText("Users").getAttribute("aria-current")).toBe("location");
});

it("suggests matching folders under the typed parent and opens a keyboard selection", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    if (args.folder === "/srv/")
      return {
        path: "/srv",
        entries: [
          { name: "Shared", kind: "folder", size: null },
          { name: "shared.txt", kind: "file", size: 12 },
        ],
      };
    return { path: args.folder ?? "/home/fixture", entries: [] };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const path = await editPath(user);
  await user.clear(path);
  await user.paste("/srv/sh");
  await screen.findByRole("option", { name: "Shared" });
  await user.type(path, "a");
  expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual([
    "Shared",
  ]);
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Shared", selected: true })).toBeTruthy();
  await user.keyboard("{Enter}");
  expect((await screen.findByText("Shared")).getAttribute("aria-current")).toBe("location");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(invoke.mock.calls.filter(([, args]) => args.folder === "/srv/")).toHaveLength(1);
});

it("uses the just-loaded folder listing when Enter opens the suggested parent path", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    return {
      path: args.folder ? "/srv" : "/home/fixture",
      entries: args.folder ? [{ name: "Shared", kind: "folder", size: null }] : [],
    };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const path = await editPath(user);
  await user.clear(path);
  await user.paste("/srv/");
  await screen.findByRole("option", { name: "Shared" });
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Open folder Shared" });
  expect(invoke.mock.calls.map(([, args]) => args.folder)).toEqual([null, "/srv/"]);
  await user.click(screen.getByRole("button", { name: "Refresh folder" }));
  expect(invoke.mock.calls.map(([, args]) => args.folder)).toEqual([null, "/srv/", "/srv"]);
});

it("keeps focus with multiple suggestions and completes a single match with Tab", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    const entries = (names: string[]) =>
      names.map((name) => ({ name, kind: "folder", size: null }));
    return {
      path: args.folder ?? "/home/fixture",
      entries: entries(args.folder === null ? ["reports", "reviews"] : ["2026"]),
    };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const path = await editPath(user);
  await user.clear(path);
  await user.paste("/home/fixture/re");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.tab();
  expect(document.activeElement).toBe(path);
  expect(path.value).toBe("/home/fixture/re");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.keyboard("{Escape}");
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh folder" }));
  expect(screen.queryByRole("combobox")).toBeNull();
  const next = await editPath(user);
  await user.clear(next);
  await user.paste("/home/fixture/rep");
  expect(screen.getByRole("option", { name: "reports" })).toBeTruthy();
  await user.tab();
  expect(next.value).toBe("/home/fixture/reports/");
  expect(document.activeElement).toBe(next);
  await screen.findByRole("option", { name: "2026" });
  await user.tab();
  expect(next.value).toBe("/home/fixture/reports/2026/");
  expect(document.activeElement).toBe(next);
  expect(screen.getByRole("button", { name: "Upload files" })).toHaveProperty("disabled", true);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Upload files" })).toHaveProperty("disabled", false),
  );
});

it("uses the loaded folder for suggestions when typing a Windows path", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command !== "list_transfer_folder") throw new Error(command);
    return {
      path: args.folder ?? "/C:/Users/fixture",
      entries: args.folder ? [] : [{ name: "Documents", kind: "folder", size: null }],
    };
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const path = await editPath(user);
  await user.clear(path);
  await user.paste(String.raw`C:\Users\fixture\Doc`);
  const suggestion = await screen.findByRole("option", { name: "Documents" });
  const name = suggestion.querySelector("span")!;
  await user.hover(name);
  expect(suggestion.hasAttribute("title")).toBe(false);
  expect(name.hasAttribute("title")).toBe(false);
  await user.unhover(name);
  Object.defineProperties(name, {
    clientWidth: { value: 40 },
    scrollWidth: { value: 80 },
  });
  await user.hover(name);
  expect(name.title).toBe("Documents");
  await user.click(suggestion);
  expect((await screen.findByText("Documents")).getAttribute("aria-current")).toBe("location");
  expect(invoke.mock.calls.map(([, args]) => args.folder)).toEqual([
    null,
    "/C:/Users/fixture/Documents",
  ]);
});

it("downloads a remote selection to the chosen local folder and waits for overwrite consent", async () => {
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_transfer_folder")
      return args.folder
        ? { path: "/home/fixture/docs", entries: [{ name: "notes.txt", kind: "file", size: 24 }] }
        : { path: "/home/fixture", entries: [{ name: "docs", kind: "folder", size: null }] };
    if (command === "choose_transfer_paths") return ["/local/Downloads"];
    if (command === "transfer_file") return args.spec.replace ? "complete" : "exists";
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  await user.click(await screen.findByRole("button", { name: "Open folder docs" }));
  await user.click(await screen.findByRole("button", { name: "Download notes.txt" }));
  await user.click(await screen.findByRole("button", { name: "Review" }));
  expect(screen.getByRole("dialog").textContent).toContain("/local/Downloads");
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "transfer_file")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Replace file" }));
  expect((await screen.findByText("Downloaded")).textContent).toBe("Downloaded");
  expect(invoke).toHaveBeenCalledWith(
    "transfer_file",
    expect.objectContaining({
      connectionId: host.id,
      spec: expect.objectContaining({
        remotePath: "/home/fixture/docs/notes.txt",
        localPath: "/local/Downloads",
        direction: "download",
        replace: true,
      }),
    }),
  );
});

it("cancels one queued upload while the first file is copying", async () => {
  let finish!: (value: string) => void;
  invoke.mockImplementation(async (command) => {
    if (command === "list_transfer_folder") return { path: "/home/fixture", entries: [] };
    if (command === "choose_transfer_paths") return ["/local/first.txt", "/local/next.txt"];
    if (command === "transfer_file")
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  await screen.findByText("This folder is empty");
  await user.click(screen.getByRole("button", { name: "Upload files" }));
  await user.click(await screen.findByRole("button", { name: "Cancel transfer of next.txt" }));
  finish("complete");
  await waitFor(() =>
    expect(fileJobs().map((job) => job.status)).toEqual(["complete", "canceled"]),
  );
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "transfer_file")).toHaveLength(1);
});

it("refreshes the folder once after a batch and keeps the listing when clearing transfers", async () => {
  const uploads: ((result: string) => void)[] = [];
  const names = ["alpha.txt", "beta.txt", "gamma.txt"];
  invoke.mockImplementation(async (command) => {
    if (command === "list_transfer_folder") return { path: "/home/fixture", entries: [] };
    if (command === "choose_transfer_paths") return names.map((name) => `/local/${name}`);
    if (command === "transfer_file") return new Promise((resolve) => uploads.push(resolve));
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  await screen.findByText("This folder is empty");
  await user.click(screen.getByRole("button", { name: "Upload files" }));
  for (let index = 0; index < names.length; index++) {
    await waitFor(() => expect(uploads).toHaveLength(index + 1));
    await act(async () => uploads[index]("complete"));
    if (index === 0) {
      await user.click(screen.getByRole("button", { name: "Clear finished" }));
      expect(invoke.mock.calls.filter(([cmd]) => cmd === "list_transfer_folder")).toHaveLength(1);
    }
  }
  await user.click(screen.getByRole("button", { name: "Clear finished" }));
  const reads = invoke.mock.calls.filter(([cmd]) => cmd === "list_transfer_folder");
  expect(reads.map(([, args]) => args.folder)).toEqual([null, "/home/fixture"]);
});

it("highlights literal matches and downloads a folder without opening it", async () => {
  invoke.mockImplementation(async (command) => {
    if (command === "list_transfer_folder")
      return {
        path: "/home/fixture",
        entries: [
          { name: "Report [Q1]", kind: "folder", size: null },
          { name: "report [q1] - [Q1].txt", kind: "file", size: 24 },
          { name: "report Q1.txt", kind: "file", size: 12 },
        ],
      };
    if (command === "choose_transfer_paths") return ["/local/Downloads"];
    if (command === "transfer_file") return "complete";
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  await user.click(await screen.findByRole("searchbox", { name: "Filter this folder" }));
  await user.paste("[q1]");
  expect(Array.from(document.querySelectorAll("mark"), (mark) => mark.textContent)).toEqual([
    "[Q1]",
    "[q1]",
    "[Q1]",
  ]);
  expect(screen.queryByRole("button", { name: "Download report Q1.txt" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Download folder Report [Q1]" }));
  await screen.findByText("Downloaded");
  expect(invoke).toHaveBeenCalledWith(
    "transfer_file",
    expect.objectContaining({
      spec: expect.objectContaining({
        direction: "download",
        folder: true,
        remotePath: "/home/fixture/Report [Q1]",
        localPath: "/local/Downloads",
      }),
    }),
  );
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "list_transfer_folder")).toHaveLength(1);
});

it("refreshes a filtered folder when an earlier upload is replaced after the batch finishes", async () => {
  let size = 1;
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_transfer_folder")
      return { path: "/home/fixture", entries: [{ name: "report.csv", kind: "file", size }] };
    if (command === "choose_transfer_paths") return ["/local/report.csv", "/local/notes.txt"];
    if (command === "transfer_file") {
      if (args.spec.replace) size = 400;
      if (args.spec.localPath.endsWith("report.csv") && !args.spec.replace) return "exists";
      return "complete";
    }
    throw new Error(command);
  });
  const user = userEvent.setup();
  render(<FilesPane connection={host} workspaceId="tab" />);
  const filter = await screen.findByRole("searchbox", { name: "Filter this folder" });
  await user.type(filter, "report");
  await user.click(screen.getByRole("button", { name: "Upload files" }));
  await screen.findByText("Uploaded");
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Replace file" }));
  await screen.findByText("400 B");
  expect((filter as HTMLInputElement).value).toBe("report");
});

it("hit-tests a scaled split pane and ignores drops over dialogs", () => {
  document.body.innerHTML =
    '<section data-file-workspace="second"><div></div><article role="dialog"><button></button></article></section>';
  const pane = document.querySelector("section")!;
  const hit = vi.fn().mockReturnValue(pane.firstElementChild);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  vi.stubGlobal("devicePixelRatio", 2);
  expect(fileDropTarget({ x: 540, y: 100 })).toBe(pane);
  expect(hit).toHaveBeenCalledWith(270, 50);
  hit.mockReturnValue(pane.querySelector("button"));
  expect(fileDropTarget({ x: 540, y: 100 })).toBeNull();
  pane.remove();
});
