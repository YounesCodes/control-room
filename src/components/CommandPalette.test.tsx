// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
afterEach(() => {
  cleanup();
  if (scrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
it("keeps keyboard selection when scrolling puts another option under a stationary pointer", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const action = vi.fn();
  render(
    <CommandPalette
      connections={[]}
      localShells={[]}
      workspaces={[]}
      activeWorkspaceId={null}
      activeView={null}
      canOpenNewTerminal={false}
      activeWorkspaceIsLocal={false}
      canFocusTerminal={false}
      canSplitTerminal={false}
      views={[]}
      hostCapabilities={{}}
      labelForWorkspace={() => ""}
      onClose={action}
      onOpenConnection={action}
      onOpenLocalShell={action}
      onSelectWorkspace={action}
      onSetView={action}
      onNewTerminal={action}
      onReconnect={action}
      onCloseWorkspace={action}
      onFocusTerminal={action}
      onFindTerminal={action}
      onSplitTerminal={action}
      onRenameWorkspace={action}
      onManageConnections={action}
      onAddConnection={action}
      onOpenSettings={action}
      onCheckForUpdates={action}
    />,
  );
  const input = screen.getByRole("combobox");
  const options = screen.getAllByRole("option");
  fireEvent.mouseMove(options[0], { clientX: 30, clientY: 40 });
  fireEvent.keyDown(input, { key: "End" });
  expect(input.getAttribute("aria-activedescendant")).toBe(options.at(-1)!.id);
  fireEvent.mouseMove(options[0], { clientX: 30, clientY: 40 });
  expect(input.getAttribute("aria-activedescendant")).toBe(options.at(-1)!.id);
  fireEvent.mouseMove(options[0], { clientX: 31, clientY: 40 });
  expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
});
