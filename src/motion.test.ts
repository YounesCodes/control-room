import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

/** Body of the first rule whose selector matches exactly, failing when the
 *  rule is gone. Selectors are anchored to the start of a line so compound
 *  selectors that merely end in the same class (`.session-pane-tabs
 *  .session-tab-wrap`) do not shadow the base rule. Follows the
 *  source-scanning pattern of the typography and palette guardrails: motion
 *  here is CSS-only, so the stylesheet is the behavior under test. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesSource.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe("motion guardrails", () => {
  it("kills every animation and transition under reduced motion", () => {
    const reduced = stylesSource.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
    expect(reduced, "the reduced-motion block is missing").toBeTruthy();
    for (const declaration of [
      "animation-duration: 0.01ms !important",
      "animation-delay: 0s !important",
      "animation-iteration-count: 1 !important",
      "transition-duration: 0.01ms !important",
      "transition-delay: 0s !important",
    ]) {
      expect(reduced?.[0]).toContain(declaration);
    }
  });

  it("never animates the terminal surface", () => {
    // xterm measures and paints on its own schedule; a transition on the
    // container would smear every resize and refit.
    expect(rule(".terminal-container")).not.toMatch(/\b(animation|transition):/);
    for (const [, selector, block] of stylesSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (selector.includes(".xterm")) {
        expect(block, `${selector.trim()} animates the terminal`).not.toMatch(
          /\b(animation|transition):/,
        );
      }
    }
  });

  it("answers presses on compact controls with a dip and keeps the host menu centered", () => {
    expect(rule("button")).toContain("transform var(--motion-fast)");
    expect(stylesSource).toContain("transform: scale(0.93)");
    // The host menu button centers itself with a transform; pressing it must
    // not drop that centering.
    expect(stylesSource).toContain("transform: translateY(-50%) scale(0.93)");
  });

  it("deepens dense rows and tabs on press instead of scaling them", () => {
    for (const selector of [
      ".host-row:not(.active):active",
      ".feature-nav button:not(.active):active",
      ".session-tab-wrap:not(.active):active",
      ".session-tab-group:not(.active):active",
    ]) {
      expect(stylesSource).toContain(selector);
    }
    // Native window controls mimic the operating system and never dip.
    expect(stylesSource).not.toContain(".window-control-button:active");
  });

  it("breathes while connecting and pops in the terminal activity cue", () => {
    expect(stylesSource).toMatch(/\.presence\.presence-connecting\s*\{[^}]*animation: spin/);
    expect(rule(".status-connecting")).toContain("animation: state-pulse");
    expect(rule(".terminal-activity")).toContain("animation: cue-in");
    expect(rule(".terminal-activity-bell")).toContain("bell-ping");
  });

  it("announces a downloaded update with a resting halo built from the success token", () => {
    const ready = rule('.update-indicator-dot[data-state="ready"]');
    expect(ready).toContain("animation: ready-ping");
    // The halo derives from --success through color-mix; a new literal hue
    // would break the monochrome palette contract.
    expect(stylesSource).toMatch(
      /@keyframes ready-ping \{[\s\S]*?color-mix\(in srgb, var\(--success\)/,
    );
  });

  it("fades the active tab underline instead of snapping it", () => {
    expect(rule(".session-tab-wrap")).toContain("border-bottom-color var(--motion-fast)");
  });

  it("drags the trailing tab dot across and slides the tab tools into place", () => {
    // Hovering reserves the action space by animating padding, so the label
    // and session dot glide instead of jumping, and Rename and Close ride in
    // from the right edge they occupy when hidden. This includes the focus
    // mode pane tabs, which reveal the same controls the same way.
    expect(rule(".session-tab-main")).toContain("transition: padding var(--motion-med)");
    expect(stylesSource).toContain("transform: translateX(6px)");
    expect(stylesSource).toMatch(
      /\.session-tab-wrap:hover \.session-tab-close,[\s\S]{0,400}?transform: translateX\(0\);/,
    );
  });

  it("reveals brand colors on identity marks only where the user is headed", () => {
    for (const token of ["--os-ubuntu:", "--os-debian:", "--os-windows:", "--shell-accent:"]) {
      expect(stylesSource).toContain(token);
    }
    for (const mark of ["ubuntu", "debian", "windows"]) {
      expect(stylesSource).toContain(`.session-tab-wrap.active .host-os-${mark}`);
      expect(stylesSource).toContain(`.host-row.active .host-os-${mark}`);
    }
    expect(stylesSource).toContain(".session-tab-wrap.active .local-shell-icon");
    // The generic mark carries no brand and must stay neutral everywhere.
    expect(stylesSource).not.toContain(".host-os-unknown");
    expect(stylesSource).not.toContain("in-layout");
  });

  it("opens anchored menus and panels with the shared popover entrance", () => {
    for (const selector of [
      ".host-context-menu",
      ".session-tab-overflow-menu",
      ".local-shell-menu",
      ".terminal-target-menu",
      ".update-panel",
      ".host-metrics-panel",
      ".font-suggestions",
      ".terminal-search",
    ]) {
      expect(rule(selector)).toContain("animation: popover-in");
    }
  });

  it("rises centered dialogs in place and keeps the palette dropping from above", () => {
    expect(rule(".modal")).toContain("animation: dialog-in");
    expect(rule(".command-palette")).toContain("animation: popover-in");
  });

  it("fades panel states in and out of view", () => {
    expect(rule(".panel-state")).toContain("animation: overlay-in");
  });

  it("rotates the connection group chevron from aria-expanded instead of swapping glyphs", () => {
    expect(rule('.connection-group-heading[aria-expanded="false"] > svg')).toContain(
      "transform: rotate(-90deg)",
    );
    expect(rule(".connection-group-heading > svg")).toContain(
      "transition: transform var(--motion-med)",
    );
    expect(appSource).toContain("<ChevronDown size={13} />");
    expect(appSource).not.toMatch(/collapsed \? <Chevron/);
  });

  it("gives command palette items a hover fill and a smooth selection", () => {
    expect(rule(".command-item")).toContain("transition");
    expect(rule(".command-item:hover")).toContain("background: var(--fill-hover)");
  });
});
