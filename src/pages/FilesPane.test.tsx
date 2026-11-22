// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  await user.click(await screen.findByRole("searchbox", { name: "Filter files" }));
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
  const filter = await screen.findByRole("searchbox", { name: "Filter files" });
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
