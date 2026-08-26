import { z } from "zod";
import { decide } from "@/lib/session";
import { harnessErrorMessage, sseResponse } from "@/lib/sse";

export const dynamic = "force-dynamic";

const approvalSchema = z.object({
  threadId: z.string().min(1),
  toolCallId: z.string().min(1, "toolCallId must not be empty"),
  status: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

/**
 * Resumes a turn that paused on a tool approval. The human verdict arrives in
 * the body and rides back to the harness through the transport; the continued
 * turn streams back as Server-Sent Events.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = approvalSchema.safeParse(body);
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
    const events = await decide(sessionId, parsed.data);
    return sseResponse(events, { signal: request.signal });
  } catch (error) {
    return Response.json({ error: harnessErrorMessage(error) }, { status: 503 });
  }
}
