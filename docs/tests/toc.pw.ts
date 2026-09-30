import { expect, test } from "@playwright/test";

for (const height of [900, 1400]) {
  test(`clicked sections stay selected with a ${height}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height });
    await page.goto("reference/security/");
    const links = page.locator(".right-sidebar docs-toc a");
    for (const link of (await links.all()).reverse()) {
      await link.click();
      await expect(link).toHaveAttribute("aria-current", "true");
      await expect(page.locator('.right-sidebar docs-toc a[aria-current="true"]')).toHaveCount(1);
    }
  });
}

test("keyboard navigation, Back and reload select the linked section", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto("reference/security/");
  const stored = page.locator('docs-toc a[href="#stored-locally"]');
  const never = page.locator('docs-toc a[href="#never-stored"]');
  await stored.click();
  await never.focus();
  await page.keyboard.press("Enter");
  await expect(never).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expect(stored).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(stored).toHaveAttribute("aria-current", "true");
});

test("manual scrolling resumes section tracking after an anchor click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto("reference/security/");
  const never = page.locator('docs-toc a[href="#never-stored"]');
  await never.click();
  await expect(never).toHaveAttribute("aria-current", "true");
  await page.mouse.move(900, 300);
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(page.locator('docs-toc a[href="#_top"]')).toHaveAttribute("aria-current", "true");
});

test("the mobile menu selects a section and closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto("reference/security/");
  const toc = page.locator("docs-mobile-toc");
  await toc.locator("summary").click();
  const stored = toc.locator('a[href="#stored-locally"]');
  await stored.click();
  await expect(stored).toHaveAttribute("aria-current", "true");
  await expect(toc.locator(".display-current")).toHaveText("Stored locally");
  await expect(toc.locator("details")).not.toHaveAttribute("open", "");
});
