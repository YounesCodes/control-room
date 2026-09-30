import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";

import { codeStyle } from "./src/code-style.mjs";
import { wrapTables } from "./src/table-plugin.mjs";

export default defineConfig({
  site: "https://younescodes.github.io",
  base: "/control-room",
  markdown: { processor: satteri({ hastPlugins: [wrapTables] }) },
  integrations: [
    starlight({
      title: "Control Room",
      description: "Documentation for the Windows SSH client with read-only Linux host inspection.",
      // The shipped app tile carries its own near-black fill and border, which
      // reads as a floating button in the nav and as the heaviest object on the
      // page in light mode. The header gets the bare glyph instead; the tile
      // stays the favicon, where a filled icon is what the format wants. An
      // <img> cannot inherit the page colour, so the ink ships per theme.
      logo: {
        light: "./src/assets/control-room-mark-light.svg",
        dark: "./src/assets/control-room-mark-dark.svg",
        alt: "Control Room",
      },
      favicon: "/app-icon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/YounesCodes/control-room",
        },
      ],
      expressiveCode: codeStyle,
      customCss: ["./src/styles/custom.css"],
      components: {
        TableOfContents: "./src/components/TableOfContents.astro",
        MobileTableOfContents: "./src/components/MobileTableOfContents.astro",
      },
      editLink: {
        baseUrl: "https://github.com/YounesCodes/control-room/edit/main/docs/",
      },
      disable404Route: true,
      lastUpdated: true,
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      sidebar: [
        { label: "Home", link: "/" },
        {
          label: "Start",
          collapsed: false,
          items: [
            { label: "Quick start", slug: "start-here/quick-start" },
            { label: "Install and requirements", slug: "start-here/installation" },
            { label: "Connections", slug: "connections" },
            { label: "Terminals and tabs", slug: "terminal" },
            { label: "Local terminals", slug: "local-terminals" },
          ],
        },
        {
          label: "Host inspection",
          collapsed: false,
          items: [
            { label: "Overview", slug: "inspection/overview" },
            { label: "Systemd", slug: "inspection/services" },
            { label: "Ports", slug: "inspection/ports" },
            { label: "Docker", slug: "inspection/docker" },
            { label: "Logs", slug: "inspection/logs" },
            { label: "Boot diagnostics", slug: "inspection/boot" },
            { label: "Baselines", slug: "inspection/baselines" },
          ],
        },
        {
          label: "More",
          collapsed: false,
          items: [
            { label: "History and notes", slug: "tools/history" },
            { label: "Settings", slug: "reference/settings" },
            { label: "Security and storage", slug: "reference/security" },
            { label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
            { label: "Troubleshooting", slug: "help/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
