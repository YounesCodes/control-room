import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

let fixture: HTMLDivElement;
let terminal: Terminal | undefined;
let motionOverride: HTMLStyleElement | undefined;

afterEach(() => {
  terminal?.dispose();
  terminal = undefined;
  fixture.remove();
  motionOverride?.remove();
  motionOverride = undefined;
});

const color = (section: HTMLElement) =>
  section.classList.contains("host-metrics-values") &&
  CSS.supports("scrollbar-color", "red transparent")
    ? getComputedStyle(section).scrollbarColor
    : getComputedStyle(section, "::-webkit-scrollbar-thumb").backgroundColor;
// Relative colors may serialize as color(srgb ...) rather than rgba(...).
// Read the rendered color so the checks cover either browser serialization.
const pixel = (section: HTMLElement) => {
  const context = document.createElement("canvas").getContext("2d")!;
  context.fillStyle = color(section).match(/^(?:rgba?|color)\([^)]*\)/)![0];
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data;
};
const hidden = (section: HTMLElement) => expect.poll(() => pixel(section)[3]).toBe(0);

// The suite emulates prefers-reduced-motion, which collapses every transition
// to 0.01ms. Stretching durations back out lets a fade be caught mid-flight.
const stretchTransitions = () => {
  motionOverride = document.createElement("style");
  motionOverride.textContent = "*, *::before, *::after { transition-duration: 10s !important; }";
  document.head.append(motionOverride);
};

const stopTransitions = () => {
  for (const animation of document.getAnimations()) animation.cancel();
  motionOverride?.remove();
  motionOverride = undefined;
};

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
  const widths = sections.map((section) => section.clientWidth);
  expect(parseFloat(getComputedStyle(sections[0]).transitionDuration)).toBeCloseTo(0.00001, 8);

  await userEvent.unhover(sections[0]);
  for (const section of sections) {
    await hidden(section);
  }
  for (const section of sections) {
    await userEvent.hover(section);
    await expect.poll(() => pixel(section)[3]).toBe(255);
    expect([74, 106]).toContain(pixel(section)[0]);
    for (const other of sections) {
      if (other !== section) await hidden(other);
    }
    expect(sections.map((item) => item.clientWidth)).toEqual(widths);
    expect(section.scrollTop).toBe(30);
  }
  await userEvent.unhover(sections[2]);
  for (const section of sections) {
    await hidden(section);
  }
});

it.each(["div", "textarea", "metrics"])(
  "fades a %s thumb on actual hover and leave",
  async (kind) => {
    stretchTransitions();
    fixture = document.createElement("div");
    fixture.style.cssText = "position:fixed;inset:20px";
    document.body.append(fixture);
    const section = document.createElement(kind === "textarea" ? "textarea" : "div");
    if (kind === "metrics") section.className = "host-metrics-values";
    section.style.cssText = "width:160px;height:100px;overflow:auto";
    const content = document.createElement("div");
    content.style.cssText = "width:400px;height:400px";
    if (section instanceof HTMLTextAreaElement) section.value = "line\n".repeat(40);
    else section.append(content);
    fixture.append(section);
    const alpha = () => pixel(section)[3] / 255;

    await userEvent.unhover(section);
    await hidden(section);
    await userEvent.hover(section);
    await expect.poll(alpha).toBeGreaterThan(0);
    const fade = section
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "--scrollbar-thumb",
      );
    expect(fade).toBeDefined();
    // Inspect a known midpoint of the real hover transition. Sampling its
    // first pixel makes reversal checks depend on runner and pointer latency.
    fade!.pause();
    fade!.currentTime = 5_000;
    const revealing = alpha();
    expect(revealing).toBeGreaterThan(0);
    expect(revealing).toBeLessThan(1);

    await userEvent.unhover(section);
    await expect.poll(alpha).toBeLessThan(revealing);
    stopTransitions();
    await hidden(section);
  },
);

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
  expect(parseFloat(getComputedStyle(scrollbar).transitionDuration)).toBeCloseTo(0.00001, 8);
  await userEvent.hover(screen);
  await expect.poll(opacity).toBe("1");
  await userEvent.unhover(screen);
  await expect.poll(opacity).toBe("0");
  expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
});

it("fades the terminal scrollbar in and out instead of snapping", async () => {
  stretchTransitions();
  fixture = document.createElement("div");
  fixture.style.cssText = "position:fixed;left:20px;top:20px;width:600px;height:240px";
  document.body.append(fixture);
  terminal = new Terminal({ cols: 60, rows: 8 });
  terminal.open(fixture);
  await new Promise<void>((resolve) => terminal!.write("line\r\n".repeat(40), resolve));
  const screen = fixture.querySelector<HTMLElement>(".xterm-screen")!;
  const scrollbar = fixture.querySelector<HTMLElement>(".scrollbar.vertical")!;
  const opacity = () => parseFloat(getComputedStyle(scrollbar).opacity);

  await userEvent.hover(screen);
  await expect.poll(opacity).toBeGreaterThan(0);
  const revealing = opacity();
  expect(revealing).toBeLessThan(1);

  await userEvent.unhover(screen);
  await expect.poll(opacity).toBeLessThan(revealing);
  stopTransitions();
  await expect.poll(opacity).toBe(0);
});
