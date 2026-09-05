/*
  Code blocks in Control Room's palette.

  The app reserves hue for status: green means running, amber means degraded,
  red means failed. A stock syntax theme spends blue, orange, and red on
  keywords and strings, which makes every shell block the loudest thing on an
  otherwise monochrome page and drains those three colours of their meaning.
  These themes separate tokens by weight and lightness instead.

  Every colour below clears 5.5:1 against its own background, which is the
  contrast floor Expressive Code enforces. Staying above it by hand means the
  automatic correction pass never has to move a value. The two backgrounds are
  the literal values of --sl-color-gray-6 in each theme; a theme's colors feed
  the contrast maths, so they cannot be var() references the way the
  styleOverrides below can.

  Note for anyone changing this file: Expressive Code injects its stylesheet
  <link> into the rendered markdown, and Astro caches that rendered markdown in
  node_modules/.astro/data-store.json. A stale cache therefore leaves pages
  pointing at the previous build's stylesheet, and the built site loads no code
  block styles at all. `npm run build` passes --force to clear that cache for
  exactly this reason; a dev server started before an edit here needs
  `astro dev --force` to pick it up.
*/

/** Builds one monochrome theme from a background and a token ramp. */
function monochrome({ name, type, bg, titleBar, fg, comment, keyword, string, func, punctuation }) {
  return {
    name,
    type,
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      // Frames read their surfaces from these three. Left undefined they
      // resolve to transparent and a code block loses its panel against the
      // page. The terminal surface matches the editor one so both frame types
      // sit at the same depth.
      "terminal.background": bg,
      "titleBar.activeBackground": titleBar,
      "editorGroupHeader.tabsBackground": titleBar,
    },
    settings: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: comment } },
      {
        scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator"],
        settings: { foreground: keyword, fontStyle: "bold" },
      },
      {
        scope: ["string", "string.quoted", "constant.character", "punctuation.definition.string"],
        settings: { foreground: string },
      },
      {
        scope: ["entity.name.function", "support.function", "entity.name.tag", "variable.function"],
        settings: { foreground: func },
      },
      {
        scope: ["constant.numeric", "constant.language", "support.constant"],
        settings: { foreground: string },
      },
      {
        scope: ["variable", "variable.other", "entity.name.type", "support.type", "support.class"],
        settings: { foreground: fg },
      },
      {
        scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"],
        settings: { foreground: punctuation },
      },
    ],
  };
}

const dark = monochrome({
  name: "control-room-dark",
  type: "dark",
  bg: "#1c1c1b",
  titleBar: "#242423",
  fg: "#d2d2cd",
  comment: "#989893",
  keyword: "#f2f2ee",
  string: "#b3b3ae",
  func: "#e2e2dd",
  punctuation: "#a0a09a",
});

const light = monochrome({
  name: "control-room-light",
  type: "light",
  bg: "#eeeeea",
  titleBar: "#e5e5e0",
  fg: "#33332f",
  comment: "#5b5b55",
  keyword: "#101010",
  string: "#52524c",
  func: "#24241f",
  punctuation: "#5a5a54",
});

/** Expressive Code settings, passed to starlight() in astro.config.mjs. */
export const codeStyle = {
  themes: [dark, light],
  styleOverrides: {
    borderRadius: "4px",
    borderColor: "var(--sl-color-gray-5)",
    codeFontFamily: "var(--sl-font-mono)",
    uiFontFamily: "var(--sl-font)",
    frames: {
      // macOS window dots, on the docs for a Windows-only tool.
      terminalTitlebarDotsOpacity: "0",
      editorActiveTabIndicatorTopColor: "var(--sl-color-accent)",
    },
  },
};
