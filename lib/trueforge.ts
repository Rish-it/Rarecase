import { TrueForge } from "@truefoundry/trueforge-sdk";
import { parseServerEnv } from "./env";

/**
 * Server-only. TrueForge holds the model, Sentry, GitHub, and Daytona
 * credentials; this client only needs to know where the harness is and, in
 * hosted mode, how to authenticate to it. Never construct this in a component
 * that ships to the browser.
 */
export function createTrueForgeClient(): TrueForge {
  const env = parseServerEnv();

  return new TrueForge({
    baseUrl: env.TRUEFORGE_BASE_URL,
    token: env.TRUEFORGE_API_TOKEN,
  });
}

export type HarnessStatus =
  | { reachable: true; baseUrl: string; capabilities: unknown }
  // `running` distinguishes "nothing is listening" from "listening but
  // broken": the first is an expected local state, the second is a defect.
  | { reachable: false; running: boolean; baseUrl: string; error: string };

/**
 * Asks the harness what it can do. Used as the connection check: a reachable
 * harness that cannot answer this is not usable, so the two are one question.
 */
export async function readHarnessStatus(): Promise<HarnessStatus> {
  const { TRUEFORGE_BASE_URL: baseUrl } = parseServerEnv();

  try {
    const capabilities = await createTrueForgeClient().server.getCapabilities();
    return { reachable: true, baseUrl, capabilities };
  } catch (error) {
    // The harness being down is an expected state, not a crash: the UI has to
    // say so rather than render a broken case. Any HTTP answer at all — even
    // an error status — proves something is listening, so the failure is in
    // auth or protocol, not reachability.
    let running = false;
    try {
      // Any HTTP answer at all — even an error status — proves something is
      // listening, so the failure is in auth or protocol, not reachability.
      // HEAD keeps a dead body from pinning the socket until GC.
      await fetch(baseUrl, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
      running = true;
    } catch {
      running = false;
    }
    return {
      reachable: false,
      running,
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
