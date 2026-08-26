import { z } from "zod";
import { openCase } from "@/lib/session";
import { harnessErrorMessage, sseResponse } from "@/lib/sse";

export const dynamic = "force-dynamic";

const caseStartSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty"),
});

/**
 * Starts a case and streams its first turn as Server-Sent Events. The session
 * id leads the stream so the client can address follow-up requests at it.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = caseStartSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }

  try {
    const opened = await openCase(parsed.data.prompt);
    return sseResponse(opened.events, {
      signal: request.signal,
      preamble: { type: "case.started", sessionId: opened.sessionId },
    });
  } catch (error) {
    // The harness being down is an expected state, not a crash: say so in a
    // shape the UI can render, without leaking the upstream error body.
    return Response.json({ error: harnessErrorMessage(error) }, { status: 503 });
  }
}
