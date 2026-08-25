import { expect, test } from "@playwright/test";

test("the app shell loads on the mobile profile the golden case uses", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rarecase");
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
});
