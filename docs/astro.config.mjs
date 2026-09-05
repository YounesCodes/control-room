import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

import { codeStyle } from "./src/code-style.mjs";

export default defineConfig({
  site: "https://younescodes.github.io",
  base: "/control-room",
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
          label: "Getting started",
          collapsed: false,
          items: [
            { label: "Introduction", slug: "start-here/introduction" },
            { label: "Installation", slug: "start-here/installation" },
            { label: "Quick start", slug: "start-here/quick-start" },
            { label: "Requirements", slug: "start-here/requirements" },
          ],
        },
        {
          label: "Terminal & workspaces",
          collapsed: true,
          items: [
            { label: "Connections", slug: "connections" },
            { label: "SSH terminal", slug: "terminal" },
            { label: "Local terminals", slug: "local-terminals" },
            { label: "Workspaces & splits", slug: "workspaces" },
          ],
        },
        {
          label: "Host inspection",
          collapsed: true,
          items: [
            { label: "Overview", slug: "inspection/overview" },
            { label: "Systemd", slug: "inspection/services" },
            { label: "Logs", slug: "inspection/logs" },
            { label: "Ports", slug: "inspection/ports" },
            { label: "Docker", slug: "inspection/docker" },
            { label: "Boot diagnostics", slug: "inspection/boot" },
            { label: "Baselines", slug: "inspection/baselines" },
          ],
        },
        {
          label: "Tools",
          collapsed: true,
          items: [
            { label: "Enhanced History", slug: "tools/history" },
            { label: "Scratchpad", slug: "tools/scratchpad" },
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { label: "Settings", slug: "reference/settings" },
            { label: "Keyboard shortcuts", slug: "reference/keyboard-shortcuts" },
            { label: "Security", slug: "reference/security" },
          ],
        },
        {
          label: "Help",
          collapsed: true,
          items: [
            { label: "Troubleshooting", slug: "help/troubleshooting" },
            { label: "FAQ", slug: "help/faq" },
          ],
        },
        {
          label: "Development",
          collapsed: true,
          items: [
            { label: "Setup", slug: "development/setup" },
            { label: "Architecture", slug: "development/architecture" },
            { label: "Contributing", slug: "development/contributing" },
          ],
        },
      ],
    }),
  ],
});
