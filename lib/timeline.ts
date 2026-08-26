import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

/**
 * Pure timeline logic for the case file UI. Maps live harness events onto the
 * eight protocol stages from skills/rarecase-debugging/SKILL.md and coalesces
 * chatty token streams into stable entries. No React here, so the mapping is
 * unit-testable on its own.
 */

export const STAGES = [
  "Evidence",
  "Hypothesis",
  "Reproduction",
  "Diagnosis",
  "Patch",
  "Verification",
  "Approval",
  "Receipt",
] as const;

export type Stage = (typeof STAGES)[number];

export interface TimelineEntry {
  /** Stable identity: coalesced updates replace the entry instead of appending. */
  key: string;
  /** The protocol stage this belongs to, or null for the raw event log. */
  stage: Stage | null;
  kind: "message" | "event";
  title: string;
  text: string;
}

/**
 * Only events with an honest home in the protocol land on a stage. Assistant
 * narration spans every stage at once, and lifecycle chatter belongs to none,
 * so both stay in the raw log rather than being assigned by guesswork.
 */
export function mapEventToStage(event: { type: string }): Stage | null {
  switch (event.type) {
    // SKILL.md stage 3 works in the sandbox.
    case "sandbox.created":
      return "Reproduction";
    // Stage 7 is where the pause becomes a human decision.
    case "tool.approval_required":
      return "Approval";
    // Stage 8 reads back what happened once the turn has ended.
    case "turn.done":
      return "Receipt";
    default:
      return null;
  }
}

/** Message content arrives as plain text or structured parts; flatten both. */
export function contentToText(content: TrueForgeApi.ModelMessageEvent["content"]): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function applyTimelineEvent(
  entries: TimelineEntry[],
  event: TrueForgeApi.TurnStreamingEvent,
): TimelineEntry[] {
  if (event.type === "model.message.delta") {
    const key = `msg:${event.id}`;
    const fragment = event.content ?? "";
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    if (existingIndex === -1) {
      return [
        ...entries,
        { key, stage: null, kind: "message", title: "Assistant", text: fragment },
      ];
    }
    const updated = [...entries];
    const existing = updated[existingIndex];
    updated[existingIndex] = { ...existing, text: existing.text + fragment };
    return updated;
  }

  if (event.type === "model.message") {
    const key = `msg:${event.id}`;
    const next: TimelineEntry = {
      key,
      stage: null,
      kind: "message",
      title: "Assistant",
      text: contentToText(event.content),
    };
    // The transport re-yields a growing message; the longest content wins so
    // either arrival order (base first or deltas first) converges, and the
    // entry keeps its identity so React never mounts one node per token.
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    if (existingIndex === -1) {
      return [...entries, next];
    }
    const updated = [...entries];
    const existing = updated[existingIndex];
    updated[existingIndex] =
      next.text.length >= existing.text.length ? { ...existing, text: next.text } : existing;
    return updated;
  }

  return [
    ...entries,
    {
      key: `evt:${event.id}`,
      stage: mapEventToStage(event),
      kind: "event",
      title: event.type,
      text: "",
    },
  ];
}

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  sourceEventId?: string;
}

export interface ToolCallSummary {
  name: string;
  server?: string;
  argsJson?: string;
}

/**
 * The harness routes every MCP call through its own `call_tool` wrapper, so the
 * name on the tool call is always `call_tool` and the action the human is
 * actually being asked to approve sits inside the arguments. Unwrap it, and
 * fall back to the raw call when the envelope is not the expected shape —
 * streamed arguments can still be truncated JSON when a turn ends early.
 */
export function describeToolCall(call: TrueForgeApi.ToolCall): ToolCallSummary {
  const raw = call.function.arguments;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "tool_name" in parsed) {
      const envelope = parsed as { tool_name?: unknown; mcp_server?: unknown; input?: unknown };
      if (typeof envelope.tool_name === "string") {
        return {
          name: envelope.tool_name,
          server: typeof envelope.mcp_server === "string" ? envelope.mcp_server : undefined,
          argsJson: JSON.stringify(envelope.input ?? {}, null, 2),
        };
      }
    }
  } catch {
    // Not the wrapper, or not finished streaming: show what we do have.
  }
  return { name: call.function.name, argsJson: raw || undefined };
}

/**
 * A turn that pauses for a human still reports `turn.done`, with the decision
 * it is waiting on listed in `requiredActions`. Treating that as the end of the
 * case would close the approval before it was ever shown.
 */
export function pendingActions(
  event: TrueForgeApi.TurnDoneEvent,
): TrueForgeApi.ActionRequiredEvent[] {
  return "requiredActions" in event.state ? event.state.requiredActions : [];
}

/** Pulls the decision the human owes out of a pause event, if it is one. */
export function extractApproval(event: TrueForgeApi.TurnStreamingEvent): PendingApproval | null {
  if (event.type !== "tool.approval_required") {
    return null;
  }
  const call = event.toolCalls[0];
  if (!call) {
    return null;
  }
  return {
    threadId: event.threadId,
    toolCallId: call.id,
    sourceEventId: call.sourceEventId,
  };
}

const PR_URL = /https?:\/\/[^\s)"']+/g;

export interface CaseReceipt {
  text: string;
  links: string[];
}

/**
 * The receipt is whatever the final message reports, PR links extracted. A turn
 * can reach a terminal state with no output at all — cancelled, errored, or
 * stopped after a denial — so the caller may supply the last narration it saw
 * rather than close the case on a blank panel.
 */
export function buildReceipt(
  event: TrueForgeApi.TurnDoneEvent,
  fallbackText = "",
): CaseReceipt | null {
  const output = "output" in event.state ? event.state.output : null;
  const text = (contentToText(output?.content ?? null) || fallbackText).trim();
  if (!text) {
    return null;
  }
  return { text, links: text.match(PR_URL) ?? [] };
}
