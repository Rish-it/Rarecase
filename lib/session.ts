import { isEventDelta, mergeEventDelta, TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import { createTrueForgeClient } from "./trueforge";

/**
 * Server-only. Owns the conversation transport with the TrueForge harness:
 * opening a case session, streaming its turns, and resuming a turn that paused
 * on a tool approval. Never construct this in a component that ships to the
 * browser.
 */

const openCaseInput = z.object({
  prompt: z.string().min(1, "prompt must not be empty"),
});

const decisionInput = z.object({
  threadId: z.string().min(1),
  toolCallId: z.string().min(1, "toolCallId must not be empty"),
  status: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

export type TurnEvents = AsyncIterable<TrueForgeApi.TurnStreamingEvent>;

export interface OpenCaseResult {
  sessionId: string;
  events: TurnEvents;
}

export interface ApprovalDecision {
  threadId: string;
  toolCallId: string;
  status: "allow" | "deny";
  reason?: string;
}

/**
 * The SDK's resume item is camelCase (`threadId` / `toolCallId`), unlike the
 * snake_case one might assume from the wire examples; the generated types are
 * the source of truth here.
 */
function approvalItem(decision: ApprovalDecision): TrueForgeApi.UserToolApprovalEvent {
  return {
    type: "user.tool_approval",
    threadId: decision.threadId,
    toolCallId: decision.toolCallId,
    approval:
      decision.status === "allow"
        ? { status: "allow" }
        : { status: "deny", reason: decision.reason },
  };
}

/**
 * Coalesces a raw harness stream for consumers: `model.message.delta` chunks
 * are merged into their base `model.message` with the SDK's own helpers, so no
 * raw delta ever escapes this module. The base message is yielded on arrival
 * and re-yielded after each merge, letting readers watch text grow without
 * seeing fragment events. Everything else passes through untouched.
 */
async function* coalesce(raw: AsyncIterable<TrueForgeApi.TurnStreamingEvent>): TurnEvents {
  const pending = new Map<string, TrueForgeApi.ModelMessageDeltaEvent[]>();
  const bases = new Map<string, TrueForgeApi.ModelMessageEvent>();

  for await (const event of raw) {
    if (isEventDelta(event)) {
      const base = bases.get(event.id);
      if (!base) {
        // A delta may arrive before its base; hold it rather than drop text.
        const queued = pending.get(event.id) ?? [];
        queued.push(event);
        pending.set(event.id, queued);
        continue;
      }
      mergeEventDelta(base, event);
      yield base;
      continue;
    }

    if (event.type === "model.message") {
      bases.set(event.id, event);
      const queued = pending.get(event.id);
      if (queued) {
        for (const fragment of queued) mergeEventDelta(event, fragment);
        pending.delete(event.id);
      }
    }

    yield event;
  }
}

/**
 * Starts a case: creates a session for the saved rarecase agent and streams
 * its first turn. Input is parsed like environment — untrusted until proven
 * otherwise — so an empty prompt fails before any request leaves the server.
 */
export async function openCase(
  prompt: string,
  client: TrueForge = createTrueForgeClient(),
): Promise<OpenCaseResult> {
  const { prompt: parsedPrompt } = openCaseInput.parse({ prompt });

  const session = await client.sessions.create({ agent: { name: "rarecase" } });
  const sessionId = session.data.id;

  const events = await client.sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: parsedPrompt }],
  });

  return { sessionId, events: coalesce(events) };
}

/**
 * Resumes a turn that paused on `tool.approval_required`. The human verdict
 * rides back to the harness as a `user.tool_approval` input item and the
 * continued stream is returned for the same coalescing treatment.
 */
export async function decide(
  sessionId: string,
  decision: ApprovalDecision,
  client: TrueForge = createTrueForgeClient(),
): Promise<TurnEvents> {
  const parsed = decisionInput.parse(decision);

  const events = await client.sessions.createTurnStream(sessionId, {
    input: [approvalItem(parsed)],
  });

  return coalesce(events);
}

/**
 * Detects the pause event that requires a human decision. Callers use this to
 * route a live stream into the approval UI instead of pattern-matching on the
 * union themselves.
 */
export function isApprovalRequired(
  event: TrueForgeApi.TurnStreamingEvent,
): event is TrueForgeApi.ToolApprovalRequiredEvent {
  return event.type === "tool.approval_required";
}
