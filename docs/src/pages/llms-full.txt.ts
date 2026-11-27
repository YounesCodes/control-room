import type { APIRoute } from "astro";
import { contentType, docsPages, pageUrl, plainMarkdown } from "../llms";

export const GET: APIRoute = async () => {
  const pages = await docsPages();
  const sections = pages.map(
    (page) =>
      `# ${page.data.title}\n\nSource: ${pageUrl(page)}\n\n${plainMarkdown(page.body ?? "", pageUrl(page))}`,
  );
  return new Response(sections.join("\n\n---\n\n") + "\n", { headers: contentType() });
};
