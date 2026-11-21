import type { APIRoute } from "astro";
import { contentType, docsPages, docsUrl, pageUrl } from "../llms";

export const GET: APIRoute = async () => {
  const pages = await docsPages();
  const lines = [
    "# Control Room",
    "",
    "> A desktop app that opens terminals on SSH hosts and shows their services, ports, containers, and logs.",
    "",
    `All pages in one file: ${docsUrl}/llms-full.txt`,
    "",
    "## Docs",
    "",
    ...pages.map((page) => `- [${page.data.title}](${pageUrl(page)}): ${page.data.description}`),
  ];
  return new Response(lines.join("\n") + "\n", { headers: contentType() });
};
