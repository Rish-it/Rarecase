import { expect, test } from "@playwright/test";

/**
 * The three-way connection check: the Next.js server, the TrueForge SDK, and a
 * live harness. It needs a real TrueForge running on TRUEFORGE_BASE_URL, so it
 * is skipped rather than failed when the harness is absent.
 */
test("the app reaches the TrueForge harness through the SDK", async ({ request }) => {
  const response = await request.get("/api/harness");
  const body = await response.json();

  test.skip(response.status() === 503, `harness not running: ${body.error}`);

  expect(response.status()).toBe(200);
  expect(body.reachable).toBe(true);
  expect(body.baseUrl).toBe("http://localhost:8790");
  expect(body.capabilities).toBeTruthy();
});
