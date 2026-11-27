import { getCollection, type CollectionEntry } from "astro:content";

export const docsUrl = "https://younescodes.github.io/control-room";

const pageOrder = [
  "index",
  "start-here/quick-start",
  "start-here/installation",
  "connections",
  "terminal",
  "local-terminals",
  "inspection/services",
  "inspection/ports",
  "inspection/docker",
  "inspection/logs",
  "tools/history",
  "reference/settings",
  "reference/security",
  "reference/keyboard-shortcuts",
  "help/troubleshooting",
];

export async function docsPages() {
  const pages = await getCollection("docs");
  const rank = (page: CollectionEntry<"docs">) => {
    const index = pageOrder.indexOf(page.id);
    return index < 0 ? pageOrder.length : index;
  };
  return pages.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export function pageUrl(page: CollectionEntry<"docs">) {
  return page.id === "index" ? `${docsUrl}/` : `${docsUrl}/${page.id}/`;
}

export function plainMarkdown(body: string, url: string) {
  return body
    .replace(/^import .*$/gm, "")
    .replace(/<figure[\s\S]*?<\/figure>/g, "")
    .replace(/<DemoVideo[\s\S]*?\/>/g, "")
    .replace(
      /^[ \t]*<LinkButton\s+href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/LinkButton>/gm,
      "- [$2]($1)",
    )
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/g, (_, text: string) => text.trim().replace(/\s+/g, " "))
    .replace(/<\/?div\b[^>]*>/g, "")
    .replace(/\]\(\/control-room\//g, `](${docsUrl}/`)
    .replace(/\]\(#/g, `](${url}#`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contentType() {
  return { "Content-Type": "text/plain; charset=utf-8" };
}
