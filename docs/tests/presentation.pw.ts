import { expect, test } from "@playwright/test";

const pages = [
  "",
  "start-here/quick-start/",
  "reference/security/",
  "start-here/installation/",
  "reference/keyboard-shortcuts/",
  "inspection/baselines/",
];

for (const theme of ["dark", "light"]) {
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [390, 844],
  ]) {
    test(`${theme} ${width}: reading layouts and technical content`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript((value) => localStorage.setItem("starlight-theme", value), theme);
      for (const route of pages) {
        const response = await page.goto(route || "./");
        expect(response?.status()).toBe(200);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("h1")).toBeVisible();
        const metrics = await page.evaluate(() => {
          const article = document.querySelector(".sl-markdown-content")!;
          const toc = document.querySelector(".right-sidebar")!;
          return {
            page: document.documentElement.scrollWidth,
            viewport: document.documentElement.clientWidth,
            article: article.getBoundingClientRect().width,
            tocOverflow: toc.scrollWidth - toc.clientWidth,
            bodyFont: getComputedStyle(article).fontFamily,
            imagesLoaded: [...article.querySelectorAll("img")].every(
              (img) => img.complete && img.naturalWidth > 0,
            ),
          };
        });
        expect(metrics.page).toBeLessThanOrEqual(metrics.viewport);
        expect(metrics.article).toBeLessThanOrEqual(768);
        if (width >= 1152) expect(metrics.tocOverflow).toBeLessThanOrEqual(1);
        expect(metrics.bodyFont).toContain("Inter Local");
        expect(metrics.imagesLoaded).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`${route.replaceAll("/", "-") || "home"}.png`),
        });
        const table = page.locator(".sl-markdown-content table").first();
        if (await table.count()) {
          await table.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath("table.png") });
        }
        await page.locator(".pagination-links").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`${route.replaceAll("/", "-") || "home"}-footer.png`),
        });
      }
    });
  }
}

test("search, theme, copy, anchors and mobile navigation retain native behavior", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("start-here/installation/");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.locator(".pagefind-ui__search-input").fill("baselines");
  await expect(page.locator(".pagefind-ui__result-link").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("site-search dialog")).not.toBeVisible();
  await page.locator("starlight-theme-select select:visible").selectOption("light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("start-here/quick-start/");
  const copy = page.locator(".expressive-code .copy button").first();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("192.168.1.20");
  await expect(page.locator('a[href*="/edit/main/docs/"]')).toBeVisible();
  await expect(page.locator("time")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("starlight-menu-button button").click();
  const baselines = page.locator('.sidebar-content a[href$="/inspection/baselines/"]');
  await baselines.scrollIntoViewIfNeeded();
  await baselines.click();
  await expect(page.locator("h1")).toHaveText("Baselines");
  await expect(page.locator("starlight-menu-button button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const heading = page.locator(".sl-heading-wrapper h2").first();
  const id = await heading.getAttribute("id");
  await page.goto(`inspection/baselines/#${id}`);
  await expect(heading).toBeInViewport();
});
