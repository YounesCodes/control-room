// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { TabLabel, WorkspaceTabScroller, type WorkspaceTabOption } from "./WorkspaceTabScroller";

const TAB_WIDTH = 175;
const STRIP = { left: 0, right: 700, top: 0, bottom: 34 };

function Strip({
  labels,
  onReorder,
}: {
  labels: string[];
  onReorder?: (id: string, targetIndex: number) => void;
}) {
  return (
    <WorkspaceTabScroller
      items={labels.map((label, index): WorkspaceTabOption => {
        return {
          id: `id-${index + 1}`,
          label,
          active: index === 0,
          onSelect: () => {},
        };
      })}
      activeTabId="id-1"
      arrangementKey="test"
      onReorder={onReorder}
    >
      {labels.map((label, index) => (
        <div className="session-tab-wrap" key={`id-${index + 1}`}>
          <button className="session-tab-main" type="button">
            {label}
          </button>
          <button className="session-tab-close" type="button" aria-label={`Close ${label}`}>
            x
          </button>
        </div>
      ))}
    </WorkspaceTabScroller>
  );
}

function tabRect(base: Record<string, number>): DOMRect {
  return {
    x: base.left ?? 0,
    y: base.top ?? 0,
    left: base.left ?? 0,
    right: base.right ?? 0,
    top: base.top ?? 0,
    bottom: base.bottom ?? 0,
    width: base.width ?? 0,
    height: base.height ?? 0,
    toJSON: () => ({}),
  } as DOMRect;
}

// jsdom reports zero-sized boxes.
function stubStripGeometry(container: HTMLElement) {
  const content = container.querySelector<HTMLElement>(".session-tab-content")!;
  content.getBoundingClientRect = () =>
    tabRect({ ...STRIP, width: STRIP.right - STRIP.left, height: 34 });
  const wraps = [...content.querySelectorAll<HTMLElement>(":scope > .session-tab-wrap")];
  wraps.forEach((wrap, index) => {
    wrap.getBoundingClientRect = () =>
      tabRect({
        left: index * TAB_WIDTH,
        right: (index + 1) * TAB_WIDTH,
        width: TAB_WIDTH,
        height: 34,
        top: 0,
        bottom: 34,
      });
  });
}

function pointer(node: Element, type: string, x: number, y = 17) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  return fireEvent(node, event);
}

function mainButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".session-tab-main")).find(
    (button) => button.textContent === label,
  )!;
}

function isShifted(container: HTMLElement, label: string) {
  const wrap = Array.from(container.querySelectorAll<HTMLElement>(".session-tab-wrap")).find(
    (wrap) => wrap.querySelector(".session-tab-main")?.textContent === label,
  )!;
  return wrap.className.includes("session-tab-shifted");
}

describe("WorkspaceTabScroller reordering", () => {
  let frame!: FrameRequestCallback;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("drags a tab onto an earlier slot and lifts and displaces it", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 358);
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointermove", 40);
    const dragged = container.querySelector<HTMLElement>(".session-tab-dragged");
    expect(dragged).toBeTruthy();
    expect(dragged!.querySelector(".session-tab-main")!.textContent).toBe("C");
    expect(isShifted(container, "A")).toBe(true);
    expect(isShifted(container, "B")).toBe(true);
    expect(isShifted(container, "D")).toBe(false);

    pointer(third, "pointerup", 40);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("id-3", 0);
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("drops a tab into the end slot it shows when the pointer overshoots the strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 3000);
    expect(container.querySelector<HTMLElement>(".session-tab-dragged")!.style.transform).toBe(
      "translate3d(175px, 0, 0)",
    );
    pointer(third, "pointerup", 3000);
    expect(onReorder).toHaveBeenLastCalledWith("id-3", 3);
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", -300);
    expect(container.querySelector<HTMLElement>(".session-tab-dragged")!.style.transform).toBe(
      "translate3d(-350px, 0, 0)",
    );
    pointer(third, "pointerup", -300);
    expect(onReorder).toHaveBeenLastCalledWith("id-3", 0);
    expect(onReorder).toHaveBeenCalledTimes(2);
  });

  it("drags a tab onto a later slot", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const first = mainButton(container, "A");

    pointer(first, "pointerdown", 60);
    pointer(first, "pointermove", 640);
    pointer(first, "pointermove", 641);
    act(() => frame(0));
    expect(container.querySelector<HTMLElement>(".session-tab-dragged")!).toBeTruthy();
    pointer(first, "pointerup", 641);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("id-1", 3);
  });

  it("slides tabs past a tab held at the drag edge while the strip pages", () => {
    vi.useFakeTimers();
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rectSpy.mockImplementation(function (this: HTMLElement) {
      const index = this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : -1;
      if (this.classList.contains("session-tab-list"))
        return tabRect({ left: 0, right: 260, width: 260, top: 0, bottom: 34, height: 34 });
      if (this.classList.contains("session-tab-content"))
        return tabRect({ left: 0, right: 300, width: 300, top: 0, bottom: 34, height: 34 });
      if (this.classList.contains("session-tab-wrap") && index >= 0)
        return tabRect({
          left: index * 196,
          right: (index + 1) * 196,
          width: 196,
          top: 0,
          bottom: 34,
          height: 34,
        });
      return tabRect({});
    });
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    const wrapsMounted = () =>
      container.querySelectorAll(".session-tab-wrap .session-tab-main").length;
    expect(wrapsMounted()).toBe(1);

    const first = mainButton(container, "A");
    pointer(first, "pointerdown", 60);
    pointer(first, "pointermove", 280);
    act(() => {
      vi.advanceTimersByTime(350);
    });
    const offsetOf = (label: string) => {
      const wrap = mainButton(container, label).closest<HTMLElement>(".session-tab-wrap")!;
      const shift = /translate3d\((-?[\d.]+)px/.exec(wrap.style.transform)?.[1] ?? "0";
      return parseFloat(wrap.style.left) + parseFloat(shift);
    };
    expect(wrapsMounted()).toBe(3);
    expect(offsetOf("B")).toBe(-196);
    expect(offsetOf("C")).toBe(196);
    expect(container.querySelector(".session-tab-dragged .session-tab-main")!.textContent).toBe(
      "A",
    );
    const list = container.querySelector<HTMLElement>(".session-tab-list")!;
    expect(list.dataset.dragEdge).toBe("right");
    pointer(first, "pointerup", 280);
    expect(list.dataset.dragEdge).toBeUndefined();
    expect(onReorder).toHaveBeenCalledWith("id-1", 1);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("moves the native window from the strip around the tabs but not from a tab", () => {
    const { container } = render(<Strip labels={["A", "B"]} />);
    const tab = mainButton(container, "A");
    const stripBehindTabs = tab.closest(".session-tab-wrap")!.parentElement!;

    expect(stripBehindTabs.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(stripBehindTabs.parentElement!.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(tab.closest("[data-tauri-drag-region]")).toBe(stripBehindTabs);
    expect(tab.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("treats a below-threshold press as a plain click, without reordering", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 362, 18);
    pointer(third, "pointerup", 362, 18);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("shows and keeps the original order when the tab is pulled away from the strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");
    const region = container.querySelector(".session-tab-scroll-region")!;

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 40);
    act(() => frame(0));
    expect(isShifted(container, "A")).toBe(true);
    pointer(third, "pointermove", 40, 200);
    act(() => frame(0));
    expect(region.classList.contains("dragging-away")).toBe(true);
    expect(isShifted(container, "A")).toBe(false);
    expect(isShifted(container, "B")).toBe(false);
    pointer(third, "pointerup", 40, 200);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();
  });

  it("still drops a tab that drifts a few pixels off the strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 40, 42);
    act(() => frame(0));
    expect(
      container.querySelector(".session-tab-scroll-region")!.classList.contains("dragging-away"),
    ).toBe(false);
    pointer(third, "pointerup", 40, 42);
    expect(onReorder).toHaveBeenCalledWith("id-3", 0);
  });

  it("cancels the drag on Escape and keeps the strip as it was", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const third = mainButton(container, "C");

    pointer(third, "pointerdown", 360);
    pointer(third, "pointermove", 40);
    expect(container.querySelector(".session-tab-dragged")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    pointer(third, "pointerup", 40);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("leaves modified arrow keys on a focused tab alone", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C"]} onReorder={onReorder} />);
    const second = mainButton(container, "B");

    fireEvent.keyDown(second, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(second, { key: "ArrowRight", metaKey: true, shiftKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("starts drags only on the main tab button of a reorderable strip", () => {
    const onReorder = vi.fn();
    const { container } = render(<Strip labels={["A", "B", "C", "D"]} onReorder={onReorder} />);
    stubStripGeometry(container);
    const closeButtons = container.querySelectorAll<HTMLButtonElement>(".session-tab-close");
    act(() => closeButtons[2]!.focus());
    pointer(closeButtons[2]!, "pointerdown", 360);
    pointer(closeButtons[2]!, "pointermove", 40);
    pointer(closeButtons[2]!, "pointerup", 40);
    expect(onReorder).not.toHaveBeenCalled();
    expect(container.querySelector(".session-tab-dragged")).toBeNull();

    const plain = render(<Strip labels={["A", "B", "C", "D"]} />);
    expect(
      plain.container
        .querySelector(".session-tab-scroll-region")!
        .classList.contains("can-reorder"),
    ).toBe(false);
    const plainTab = mainButton(plain.container, "C");
    pointer(plainTab, "pointerdown", 360);
    pointer(plainTab, "pointermove", 40);
    pointer(plainTab, "pointerup", 40);
    expect(plain.container.querySelector(".session-tab-dragged")).toBeNull();
  });
});

interface MenuTerminal {
  label: string;
  kind?: "local" | "remote";
  status?: string;
  attention?: boolean;
}

function OverflowStrip({
  terminals,
  initialActive,
  onClose,
  menuAlwaysShown,
  trailing,
}: {
  terminals: MenuTerminal[];
  initialActive: number;
  onClose?: (label: string) => void;
  menuAlwaysShown?: boolean;
  trailing?: ReactNode;
}) {
  const [activeLabel, setActiveLabel] = useState(terminals[initialActive].label);
  const [open, setOpen] = useState(terminals);
  return (
    <WorkspaceTabScroller
      items={open.map((terminal): WorkspaceTabOption => ({
        id: terminal.label,
        label: terminal.label,
        kind: terminal.kind,
        status: terminal.status,
        attention: terminal.attention,
        active: terminal.label === activeLabel,
        onSelect: () => setActiveLabel(terminal.label),
        onClose: () => {
          onClose?.(terminal.label);
          setOpen((current) => current.filter((item) => item !== terminal));
        },
      }))}
      activeTabId={activeLabel}
      arrangementKey={open.map((terminal) => terminal.label).join("|")}
      menuAlwaysShown={menuAlwaysShown}
      trailing={trailing}
    >
      {open.map((terminal) => (
        <div className="session-tab-wrap" key={terminal.label}>
          <button className="session-tab-main" type="button">
            {terminal.label}
          </button>
        </div>
      ))}
    </WorkspaceTabScroller>
  );
}

function visibleTabs(container: HTMLElement) {
  return [...container.querySelectorAll(".session-tab-main")].map((tab) => tab.textContent);
}

function menuItems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function picker(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(".session-tab-menu-button")!;
}

function itemName(item: HTMLElement) {
  return item.textContent?.split(",")[0];
}

const terminals: MenuTerminal[] = [
  { label: "Git Bash", kind: "local" },
  { label: "Example host", kind: "remote", status: "disconnected", attention: true },
  { label: "PowerShell", kind: "local" },
  { label: "Command Prompt", kind: "local" },
  { label: "Staging host", kind: "remote" },
  { label: "Example host 2", kind: "remote" },
];

describe("WorkspaceTabScroller overflow", () => {
  const nativeScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains("session-tab-list"))
        return tabRect({ left: 0, right: 400, width: 400, top: 0, bottom: 34, height: 34 });
      if (this.classList.contains("session-tab-trailing"))
        return tabRect({ left: 260, right: 400, width: 140, top: 0, bottom: 34, height: 34 });
      return tabRect({});
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (nativeScrollIntoView)
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", nativeScrollIntoView);
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  function openMenu(container: HTMLElement) {
    fireEvent.click(container.querySelector<HTMLButtonElement>(".session-tab-menu-button")!);
  }

  it("counts every terminal and flags hidden ones that need attention", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    expect(visibleTabs(container)).toEqual(["Staging host", "Example host 2"]);
    expect(container.querySelector(".session-tab-pager")).toBeNull();
    const button = picker(container);
    const list = container.querySelector<HTMLElement>(".session-tab-list")!;
    expect(button.getAttribute("aria-label")).toBe("All terminals");
    expect(button.querySelector<HTMLElement>("[data-count]")!.dataset.count).toBe("6");
    expect(button.title).toBe("All terminals: 4 not in the tab row, one needs attention");
    expect(button.dataset.attention).toBe("true");
    expect(list.dataset.moreLeft).toBe("true");
    expect(list.dataset.moreRight).toBeUndefined();

    openMenu(container);
    fireEvent.click(menuItems(container).find((item) => itemName(item) === "Example host")!);
    expect(visibleTabs(container)).toEqual(["Example host", "PowerShell"]);
    expect(button.title).toBe("All terminals: 4 not in the tab row");
    expect(button.dataset.attention).toBeUndefined();
    expect(list.dataset.moreLeft).toBe("true");
    expect(list.dataset.moreRight).toBe("true");
  });

  it("keeps the menu and its button while closing terminals until it is dismissed", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    const heading = () => container.querySelector(".session-tab-menu-heading")!.textContent;
    expect(heading()).toBe("All terminals6 open");
    for (let closed = 0; closed < 4; closed++) {
      const focused = document.activeElement as HTMLElement;
      fireEvent.keyDown(focused, { key: "Delete" });
    }
    expect(visibleTabs(container)).toHaveLength(2);
    expect(menuItems(container)).toHaveLength(2);
    expect(menuItems(container)).toContain(document.activeElement);
    expect(heading()).toBe("All terminals2 open");
    expect(picker(container).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".session-tab-list")!.hasAttribute("data-more-left")).toBe(
      false,
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(container.querySelector(".session-tab-menu-button")).toBeNull();
  });

  it("keeps a pinned menu button when every tab fits", () => {
    const { container } = render(
      <OverflowStrip terminals={terminals.slice(0, 2)} initialActive={0} menuAlwaysShown />,
    );
    expect(visibleTabs(container)).toEqual(["Git Bash", "Example host"]);
    expect(picker(container).querySelector<HTMLElement>("[data-count]")!.dataset.count).toBe("2");
    expect(picker(container).title).toBe("All terminals");
  });

  it("closes the menu on a click anywhere but the menu and its button", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    fireEvent.pointerDown(menuItems(container)[0]);
    expect(picker(container).getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(container.querySelector(".session-tab-main")!);
    expect(picker(container).getAttribute("aria-expanded")).toBe("false");
  });

  it("sizes tabs beside the trailing control and leaves wheel input over it alone", () => {
    const { container } = render(
      <OverflowStrip
        terminals={terminals}
        initialActive={5}
        trailing={<button type="button">New terminal</button>}
      />,
    );
    expect(visibleTabs(container)).toEqual(["Example host 2"]);
    const content = container.querySelector<HTMLElement>(".session-tab-content")!;
    expect(content.style.width).toBe("196px");
    const newTerminal = container.querySelector(".session-tab-trailing button")!;
    expect(content.nextElementSibling).toBe(newTerminal.parentElement);
    fireEvent.wheel(newTerminal, { deltaY: -200 });
    expect(visibleTabs(container)).toEqual(["Example host 2"]);
    fireEvent.wheel(content, { deltaY: -200 });
    expect(visibleTabs(container)).toEqual(["Staging host"]);
  });

  it("scrolls a terminal chosen from the menu or newly activated into view", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    const items = menuItems(container);
    expect(items.filter((item) => item.getAttribute("aria-current") === "page")).toHaveLength(1);
    const gitBash = items.find((item) => itemName(item) === "Git Bash")!;
    expect(gitBash.textContent).toContain("hidden to the left");
    fireEvent.click(gitBash);
    expect(visibleTabs(container)).toEqual(["Git Bash", "Example host"]);
    expect(picker(container).getAttribute("aria-expanded")).toBe("false");

    openMenu(container);
    fireEvent.click(menuItems(container).find((item) => itemName(item) === "Example host 2")!);
    expect(visibleTabs(container)).toEqual(["Staging host", "Example host 2"]);
  });

  it("shows status only where it carries information and groups local shells apart", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    const groups = [...container.querySelectorAll('[role="menu"] > [role="group"]')];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Local shells",
      "Connections",
    ]);
    expect(
      [...container.querySelectorAll(".session-tab-menu-status")].map((status) =>
        status.textContent?.replace(", ", ""),
      ),
    ).toEqual(["disconnected"]);
    expect(container.querySelector(".session-tab-menu-check")).toBeNull();
  });

  it("navigates the menu with wrapping arrows and returns focus on Escape", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    const items = menuItems(container);
    expect(items.map(itemName)).toEqual([
      "Git Bash",
      "PowerShell",
      "Command Prompt",
      "Example host",
      "Staging host",
      "Example host 2",
    ]);
    expect(document.activeElement).toBe(items[5]);
    fireEvent.keyDown(items[5], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    scrollIntoView.mockClear();
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[5]);
    expect(scrollIntoView.mock.contexts).toEqual([items[5]]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.keyDown(items[5], { key: "Escape" });
    expect(picker(container).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(picker(container));
  });

  it("filters by typing and selects the first match with Enter", () => {
    const { container } = render(<OverflowStrip terminals={terminals} initialActive={5} />);
    openMenu(container);
    expect(container.querySelector(".session-tab-menu-filter")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "p" });
    const filter = container.querySelector<HTMLInputElement>(".session-tab-menu-filter")!;
    expect(filter.value).toBe("p");
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "power" } });
    expect(menuItems(container).map(itemName)).toEqual(["PowerShell"]);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(picker(container).getAttribute("aria-expanded")).toBe("false");
    expect(visibleTabs(container)).toContain("PowerShell");
  });

  it("closes the focused terminal with Delete and keeps the menu open on the next row", () => {
    const onClose = vi.fn();
    const { container } = render(
      <OverflowStrip terminals={terminals} initialActive={5} onClose={onClose} />,
    );
    openMenu(container);
    const items = menuItems(container);
    fireEvent.keyDown(items[5], { key: "ArrowDown" });
    fireEvent.keyDown(items[0], { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("Git Bash");
    const remaining = menuItems(container);
    expect(remaining).toHaveLength(5);
    expect(document.activeElement).toBe(remaining[0]);
    expect(itemName(remaining[0])).toBe("PowerShell");
  });
});

describe("TabLabel", () => {
  afterEach(cleanup);

  it("splits a trailing number into its own span without changing the label text", () => {
    const { container } = render(<TabLabel label="PowerShell 7" />);
    expect(container.querySelector(".session-tab-label-base")?.textContent).toBe("PowerShell");
    expect(container.querySelector(".session-tab-label-suffix")?.textContent).toBe(" 7");
    expect(container.querySelector(".session-tab-label")?.textContent).toBe("PowerShell 7");
  });

  it("renders a name without a trailing number as plain text", () => {
    const { container, getByRole } = render(
      <button type="button">
        <TabLabel label="Git Bash" />
      </button>,
    );
    expect(getByRole("button", { name: "Git Bash" })).toBeTruthy();
    expect(container.querySelector(".session-tab-label-suffix")).toBeNull();
  });
});
