import { expect, test } from "@playwright/test";

for (const width of [1440, 768, 390]) {
  test(`tables fill their frame at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["inspection/baselines/", "reference/keyboard-shortcuts/"]) {
      await page.goto(route);
      const table = page.locator(".sl-markdown-content table");
      await expect(table).toBeVisible();
      const sizes = await table.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll("tr")].map((row) => ({
          gap: bounds.right - row.getBoundingClientRect().right,
          width: row.getBoundingClientRect().width,
          tableWidth: bounds.width,
        }));
      });
      for (const size of sizes) {
        expect(Math.abs(size.gap)).toBeLessThanOrEqual(2);
        expect(Math.abs(size.width - size.tableWidth)).toBeLessThanOrEqual(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });
}
