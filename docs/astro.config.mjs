import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://younescodes.github.io",
  base: "/control-room",
  integrations: [
    starlight({
      title: "Control Room",
      description: "Documentation for the Windows SSH client with read-only Linux host inspection.",
      logo: {
        src: "./src/assets/app-icon.svg",
        alt: "Control Room app icon",
      },
      favicon: "/app-icon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/YounesCodes/control-room",
        },
      ],
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
            { label: "Services", slug: "inspection/services" },
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
