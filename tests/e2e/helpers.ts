import { test, type APIRequestContext } from "@playwright/test";

interface HarnessHealth {
  reachable?: boolean;
  running?: boolean;
  baseUrl?: string;
  error?: string;
}

/** True only when nothing answers at the harness address at all. */
export async function skipUnlessHarnessListening(request: APIRequestContext): Promise<void> {
  const health = await request.get("/api/harness");
  const status = (await health.json()) as HarnessHealth;
  test.skip(
    status.reachable === false && status.running === false,
    `TrueForge harness not listening at ${status.baseUrl ?? "(unknown)"}: ${status.error ?? "no error reported"}`,
  );
}
