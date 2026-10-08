// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontCatalogPicker } from "./FontCatalogPicker";
import type { FontProgress } from "../types";

const api = vi.hoisted(() => ({
  listCatalogFonts: vi.fn(),
  previewCatalogFont: vi.fn(),
  installCatalogFont: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage = (value: FontProgress) => {
      void value;
    };
  },
}));
const fonts = [
  { id: "fira-mono", family: "Fira Mono", license: "OFL-1.1" },
  { id: "jetbrains-mono", family: "JetBrains Mono", license: "OFL-1.1" },
];
const add = vi.fn();
const remove = vi.fn();
const load = vi.fn();
function mount() {
  const onUse = vi.fn(async () => {});
  const onPreview = vi.fn();
  const onBusyChange = vi.fn();
  const onChange = vi.fn();
  render(
    <FontCatalogPicker
      value="Consolas, monospace"
      onChange={onChange}
      onUse={onUse}
      onPreview={onPreview}
      onBusyChange={onBusyChange}
    />,
  );
  fireEvent.focus(screen.getByRole("combobox"));
  return { onUse, onPreview, onBusyChange, onChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listCatalogFonts.mockResolvedValue({ fonts, stale: false });
  api.previewCatalogFont.mockResolvedValue(new ArrayBuffer(8));
  api.installCatalogFont.mockResolvedValue("JetBrains Mono");
  load.mockResolvedValue([]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add, delete: remove, load },
  });
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(public family: string) {}
      async load() {
        return this;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("catalog font lifecycle", () => {
  it("accepts an installed font and fallback list while the catalog is offline", async () => {
    api.listCatalogFonts.mockRejectedValueOnce("Offline");
    const props = mount();
    await screen.findByText(/Offline.*current font is unchanged/);
    const field = screen.getByRole("combobox", { name: "Font family" });
    expect(field).toHaveProperty("value", "Consolas, monospace");
    fireEvent.change(field, { target: { value: '"Cascadia Code", Consolas, monospace' } });
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onChange).toHaveBeenCalledWith('"Cascadia Code", Consolas, monospace');
    expect(api.installCatalogFont).not.toHaveBeenCalled();
    expect(props.onUse).not.toHaveBeenCalled();
  });

  it("dismisses search on focus leaving the picker without committing partial text", async () => {
    const props = mount();
    const field = screen.getByRole("combobox");
    fireEvent.change(field, { target: { value: "jet" } });
    await screen.findByRole("option", { name: /JetBrains Mono/ });
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.blur(field, { relatedTarget: outside });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field).toHaveProperty("value", "Consolas, monospace");
    expect(props.onChange).not.toHaveBeenCalled();
    outside.remove();
  });

  it("keeps an entered font through the explicit manual action", async () => {
    const props = mount();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Cascadia Code, monospace" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Use typed font" }));
    expect(props.onChange).toHaveBeenCalledWith("Cascadia Code, monospace");
    expect(api.installCatalogFont).not.toHaveBeenCalled();
  });

  it("searches, previews the name and sample, and releases preview faces without installing", async () => {
    const props = mount();
    await screen.findByRole("option", { name: /Fira Mono/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "jet" } });
    await waitFor(() =>
      expect(props.onPreview).toHaveBeenCalledWith(
        '"ControlRoomPreview-jetbrains-mono", monospace',
      ),
    );
    expect(screen.queryByRole("option", { name: /Fira Mono/ })).toBeNull();
    expect(screen.getByText("JetBrains Mono").style.fontFamily).toContain(
      "ControlRoomPreview-jetbrains-mono",
    );
    expect(api.installCatalogFont).not.toHaveBeenCalled();
    expect(props.onUse).not.toHaveBeenCalled();
    expect(props.onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("option", { name: /JetBrains Mono/ }));
    await userEvent.click(screen.getByRole("button", { name: "Keep current font" }));
    expect(props.onPreview).toHaveBeenLastCalledWith(null);
    cleanup();
    expect(remove).toHaveBeenCalled();
  });

  it("accepts keyboard suggestions without installing, and Escape restores the current value", async () => {
    const props = mount();
    await screen.findByRole("option", { name: /Fira Mono/ });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Fira Mono/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /JetBrains Mono/ }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.getByRole("combobox")).toHaveProperty("value", "JetBrains Mono");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(api.installCatalogFont).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("combobox")).toHaveProperty("value", "Consolas, monospace");
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Fira Mono/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  });

  it("keeps the current font on failure and retries with download and install progress", async () => {
    const props = mount();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "jet" } });
    await userEvent.click(await screen.findByRole("option", { name: /JetBrains Mono/ }));
    api.installCatalogFont.mockRejectedValueOnce("Windows denied access to your font folder.");
    await userEvent.click(screen.getByRole("button", { name: "Install and use" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Windows denied access"),
    );
    expect(props.onUse).not.toHaveBeenCalled();
    let finish!: (family: string) => void;
    api.installCatalogFont.mockImplementationOnce((_id, channel) => {
      channel.onmessage({ stage: "downloadingRegular", completed: 50, total: 100 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry install and use" }));
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
    const channel = api.installCatalogFont.mock.calls.at(-1)![1];
    act(() => channel.onmessage({ stage: "installing", completed: 1, total: 2 }));
    expect(screen.getByText(/Installing for your Windows account/)).toBeTruthy();
    await act(async () => finish("JetBrains Mono"));
    expect(props.onUse).toHaveBeenCalledWith("JetBrains Mono");
    expect(
      await screen.findByText(
        "JetBrains Mono is installed and selected for your terminals. If the new font is not visible yet, restart Control Room.",
      ),
    ).toBeTruthy();
  });

  it("reports a save failure and permits retry without claiming readiness", async () => {
    const props = mount();
    await userEvent.click(await screen.findByRole("option", { name: /Fira Mono/ }));
    props.onUse.mockRejectedValueOnce(new Error("Settings could not be saved"));
    await userEvent.click(screen.getByRole("button", { name: "Install and use" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Settings could not be saved"),
    );
    expect(screen.queryByText(/is installed and selected/)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry apply font" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("installed for your Windows account");
    expect(screen.getByRole("alert").textContent).not.toContain("current font is unchanged");
    const face = add.mock.calls.find(([face]) => face.family === "JetBrains Mono")![0];
    expect(remove).toHaveBeenCalledWith(face);
    await userEvent.click(screen.getByRole("button", { name: "Retry apply font" }));
    await screen.findByText(/is installed and selected/);
    expect(api.installCatalogFont).toHaveBeenCalledTimes(1);
    const applied = add.mock.calls.at(-1)![0];
    cleanup();
    expect(remove).toHaveBeenCalledWith(applied);
  });

  it("recovers from catalog and preview outages without applying a font", async () => {
    api.listCatalogFonts.mockRejectedValueOnce("Offline");
    const props = mount();
    await screen.findByText(/Offline.*current font is unchanged/);
    await userEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
    api.previewCatalogFont.mockRejectedValue("Preview download failed");
    await screen.findByRole("option", { name: /Fira Mono/ });
    await userEvent.click(screen.getByRole("option", { name: /Fira Mono/ }));
    await screen.findByText(/Preview download failed.*preview uses your current font/);
    api.previewCatalogFont.mockResolvedValue(new ArrayBuffer(8));
    await userEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    await waitFor(() =>
      expect(props.onPreview).toHaveBeenCalledWith('"ControlRoomPreview-fira-mono", monospace'),
    );
    expect(props.onUse).not.toHaveBeenCalled();
  });

  it("does not apply or add a font when installation finishes after unmount", async () => {
    let finish!: (family: string) => void;
    api.installCatalogFont.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const props = mount();
    await userEvent.click(await screen.findByRole("option", { name: /Fira Mono/ }));
    await userEvent.click(screen.getByRole("button", { name: "Install and use" }));
    cleanup();
    add.mockClear();
    await act(async () => finish("JetBrains Mono"));
    expect(add).not.toHaveBeenCalled();
    expect(props.onUse).not.toHaveBeenCalled();
  });

  it("ignores a late preview after unmount", async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    api.previewCatalogFont.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    await waitFor(() => expect(api.previewCatalogFont).toHaveBeenCalled());
    cleanup();
    await act(async () => finish(new ArrayBuffer(8)));
    expect(add).not.toHaveBeenCalled();
  });
});
