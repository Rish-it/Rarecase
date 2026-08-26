import { expect, test } from "@playwright/test";

import { skipUnlessHarnessListening } from "./helpers";

/**
 * Gate test: a bare create_branch request reaches the approval pause through
 * the live harness, and a denial leaves GitHub untouched. It exercises the
 * gate, not the debugging protocol — no stage before Approval fills.
 *
 * Reaching the gate takes two to four minutes of real model work depending on
 * harness latency. The worst case budget below is 300s (gate) + 2x150s
 * (denial settles) = 600s inside a 720s test timeout; every assertion stays
 * on.
 */
test.setTimeout(720_000);

const GATE_TIMEOUT = 300_000;
const DENY_TIMEOUT = 150_000;

test("a denied GitHub write stops the agent", async ({ page, request }) => {
  await skipUnlessHarnessListening(request);

  const branchName = `e2e-denied-${Date.now()}`;
  await page.goto("/");

  await page
    .getByPlaceholder("Describe the production failure…")
    .fill(
      `In the GitHub repo Rish-it/Rarecase, create a branch named ${branchName} from main. Do it now.`,
    );
  await page.getByRole("button", { name: "Open case" }).click();

  const card = page.getByRole("region", { name: "Pending approval" });
  await expect(card).toBeVisible({ timeout: GATE_TIMEOUT });

  // The card names the real action inside the wrapped MCP call, not call_tool.
  await expect(card).toContainText("create_branch");

  await card.getByRole("button", { name: "Deny" }).click();
  await card
    .getByPlaceholder("Reason (optional)")
    .fill("E2E verification: repository writes are never approved from tests.");
  await card.getByRole("button", { name: "Confirm deny" }).click();

  const openCase = page.getByRole("button", { name: "Open case" });

  // The runner can only leave awaiting by consuming the resumed stream, so a
  // route-around attempt holds the button disabled: this is where an agent
  // that ignores the refusal actually fails, not in a card visibility check.
  await expect(card).toBeHidden({ timeout: DENY_TIMEOUT });
  await expect(openCase).toBeEnabled({ timeout: DENY_TIMEOUT });

  // Enabled also covers phase "error"; a clean denial surfaces no error of
  // our own. Scoped by testid: Next.js dev tools injects its own alert node.
  await expect(page.getByTestId("stream-error")).toHaveCount(0);

  // Server-side truth: the gate held only if GitHub never saw the branch.
  const probe = await request.get(
    `https://api.github.com/repos/Rish-it/Rarecase/branches/${branchName}`,
  );
  expect(probe.status(), "denied write must not have reached GitHub").toBe(404);
});
