import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

let fixture: HTMLDivElement;
let terminal: Terminal | undefined;

afterEach(() => {
  terminal?.dispose();
  terminal = undefined;
  fixture.remove();
});

it("reveals only the hovered scroll section without changing its layout or scroll position", async () => {
  fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;inset:20px;display:flex;gap:20px;align-items:start";
  document.body.append(fixture);
  const sections = ["", "", "host-metrics-values"].map((className) => {
    const section = document.createElement("div");
    section.className = className;
    section.style.cssText = "width:160px;height:100px;overflow:auto;flex:none";
    const content = document.createElement("div");
    content.style.cssText = "width:400px;height:400px";
    section.append(content);
    fixture.append(section);
    section.scrollTop = 30;
    return section;
  });
  const color = (section: HTMLElement) =>
    section.classList.contains("host-metrics-values")
      ? getComputedStyle(section).scrollbarColor
      : getComputedStyle(section, "::-webkit-scrollbar-thumb").backgroundColor;
  const hidden = (section: HTMLElement) => expect(color(section)).toContain("rgba(0, 0, 0, 0)");
  const widths = sections.map((section) => section.clientWidth);

  await userEvent.unhover(sections[0]);
  sections.forEach(hidden);
  for (const section of sections) {
    await userEvent.hover(section);
    await expect.poll(() => color(section)).toMatch(/rgb\((74, 74, 74|106, 106, 106)\)/);
    sections.filter((other) => other !== section).forEach(hidden);
    expect(sections.map((item) => item.clientWidth)).toEqual(widths);
    expect(section.scrollTop).toBe(30);
  }
  await userEvent.unhover(sections[2]);
  sections.forEach(hidden);
});

it("hides the terminal scrollbar after leaving a terminal with scrollback", async () => {
  fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;left:20px;top:20px;width:600px;height:240px";
  document.body.append(fixture);
  terminal = new Terminal({ cols: 60, rows: 8 });
  terminal.open(fixture);
  await new Promise<void>((resolve) => terminal!.write("line\r\n".repeat(40), resolve));
  const screen = fixture.querySelector<HTMLElement>(".xterm-screen")!;
  const scrollbar = fixture.querySelector<HTMLElement>(".scrollbar.vertical")!;
  const opacity = () => getComputedStyle(scrollbar).opacity;
  await userEvent.hover(screen);
  await expect.poll(opacity).toBe("1");
  await userEvent.unhover(screen);
  await expect.poll(opacity).toBe("0");
  expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
});
