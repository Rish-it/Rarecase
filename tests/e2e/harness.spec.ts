import { expect, test } from "@playwright/test";

/**
 * The three-way connection check: the Next.js server, the TrueForge SDK, and a
 * live harness. It needs a real TrueForge on TRUEFORGE_BASE_URL, so it is
 * skipped only when nothing is listening there. A harness that answers but
 * misbehaves — auth rejection, incompatible API — is a real failure and fails
 * here instead of being skipped.
 */
test("the app reaches the TrueForge harness through the SDK", async ({ request }) => {
  const response = await request.get("/api/harness");
  const body = await response.json();

  test.skip(
    body.reachable === false && body.running === false,
    `harness not listening at ${body.baseUrl}: ${body.error}`,
  );

  expect(response.status()).toBe(200);
  expect(body.reachable).toBe(true);
  expect(body.baseUrl).toBe("http://localhost:8790");
  expect(body.capabilities).toBeTruthy();
});
