import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

/**
 * Pure timeline logic for the case file UI. Maps live harness events onto the
 * eight protocol stages from skills/rarecase-debugging/SKILL.md. No React here,
 * so the mapping is unit-testable against a recorded case.
 *
 * Stages are assigned by a cursor, not by event type. The protocol is a
 * sequence, and the agent announces each stage as it enters it; work that
 * follows belongs to whichever stage is open. This is the only way Hypothesis
 * and Diagnosis can ever be populated — they run no tools — and it is also the
 * only way to tell a Reproduction test run from a Verification one, since both
 * are the same `exec` call against the same sandbox.
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
  kind: "message" | "event" | "tool";
  title: string;
  text: string;
  /** What the entry is actually about, in the agent's own words where it gave them. */
  detail?: string;
  /** A tool call whose response has come back. */
  settled?: boolean;
}

/**
 * The agent writes its stage transitions into its narration. Left to itself it
 * drifts — one run produced `**Stage 1: Evidence**`, the next
 * `**Stage 1 — Evidence**` from the same instructions — so the skill mandates a
 * literal form and this tolerates the separators observed in practice.
 */
const STAGE_MARKER = /\*\*Stage\s*(\d)\s*[:—–-]\s*([A-Za-z]+)\s*\*\*/g;

export function findStageMarker(text: string): Stage | null {
  let found: Stage | null = null;
  STAGE_MARKER.lastIndex = 0;
  for (const match of text.matchAll(STAGE_MARKER)) {
    const byNumber = STAGES[Number(match[1]) - 1];
    const named = STAGES.find((stage) => stage.toLowerCase() === match[2]?.toLowerCase());
    // The name wins over the number: a model that miscounts is still telling
    // you which stage it believes it is in.
    const stage = named ?? byNumber;
    if (stage) {
      found = stage;
    }
  }
  return found;
}

/** Removes the stage markers from text on its way to the screen. */
export function stripStageMarkers(text: string): string {
  return text
    .replace(STAGE_MARKER, "")
    .replace(/[ \t]{2,}/g, " ")
    .trimStart();
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

export interface ToolCallSummary {
  name: string;
  server?: string;
  argsJson?: string;
  /** The agent's own one-line reason for the call, when it supplied one. */
  intent?: string;
}

/**
 * Names the action a tool call performs. Three shapes have been observed on the
 * wire, so all three are handled: `toolInfo` carries the resolved name and
 * server and is preferred; some calls arrive wrapped in the harness's own
 * `call_tool` envelope with the real action inside the arguments; and the rest
 * are named directly on the function. Streamed arguments can still be truncated
 * JSON when a turn ends early, so parsing never decides whether there is a name.
 */
export function describeToolCall(call: TrueForgeApi.ToolCall): ToolCallSummary {
  const info = (call as { toolInfo?: { name?: unknown; serverName?: unknown } }).toolInfo;
  const raw = call.function.arguments;

  const summary: ToolCallSummary = {
    name: typeof info?.name === "string" ? info.name : call.function.name,
    server: typeof info?.serverName === "string" ? info.serverName : undefined,
    argsJson: raw || undefined,
  };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const fields = parsed as {
        tool_name?: unknown;
        mcp_server?: unknown;
        input?: unknown;
        intent?: unknown;
      };
      // The wrapper: the name on the call is `call_tool` and the action the
      // human would be approving sits inside the arguments.
      if (typeof fields.tool_name === "string") {
        summary.name = fields.tool_name;
        summary.server = typeof fields.mcp_server === "string" ? fields.mcp_server : summary.server;
        summary.argsJson = JSON.stringify(fields.input ?? {}, null, 2);
      } else {
        summary.argsJson = JSON.stringify(parsed, null, 2);
      }
      if (typeof fields.intent === "string") {
        summary.intent = fields.intent;
      }
    }
  } catch {
    // Not JSON, or not finished streaming: show what we do have.
  }

  return summary;
}

export interface TimelineState {
  entries: TimelineEntry[];
  /** The stage the agent last announced. Null until it announces its first. */
  stage: Stage | null;
  /** Tool call id to the entry key it created, so a response can settle it. */
  pendingCalls: Record<string, string>;
  /** Assembled text per message id, so a marker split across deltas is still seen. */
  messageText: Record<string, string>;
}

export function emptyTimeline(): TimelineState {
  return { entries: [], stage: null, pendingCalls: {}, messageText: {} };
}

function upsert(entries: TimelineEntry[], next: TimelineEntry): TimelineEntry[] {
  const index = entries.findIndex((entry) => entry.key === next.key);
  if (index === -1) {
    return [...entries, next];
  }
  const updated = [...entries];
  updated[index] = next;
  return updated;
}

/**
 * Only two events name their own stage regardless of what the agent announced:
 * a pause is the approval, and a terminal turn is the receipt. Everything else
 * follows the cursor. `sandbox.created` is deliberately not Reproduction — it
 * fires the first time the agent runs anything at all, which in practice is
 * while it is still reading the issue.
 */
function anchoredStage(type: string): Stage | null {
  if (type === "tool.approval_required") return "Approval";
  if (type === "turn.done") return "Receipt";
  return null;
}

export function applyEvent(
  state: TimelineState,
  event: TrueForgeApi.TurnStreamingEvent,
): TimelineState {
  if (event.type === "model.message" || event.type === "model.message.delta") {
    const key = `msg:${event.id}`;
    const fragment =
      event.type === "model.message.delta" ? (event.content ?? "") : contentToText(event.content);
    const previous = state.messageText[event.id] ?? "";
    // A base message re-yielded with its assembled content replaces what the
    // deltas built; a delta appends. Longest wins, so either order converges.
    const text =
      event.type === "model.message" && fragment.length >= previous.length
        ? fragment
        : previous + fragment;

    const stage = findStageMarker(text) ?? state.stage;
    let entries = upsert(state.entries, {
      key,
      stage,
      kind: "message",
      title: "Agent",
      // The marker is addressed to the case file, not to the reader: the stage
      // it names is already the heading the text sits under.
      text: stripStageMarkers(text),
    });
    const pendingCalls = { ...state.pendingCalls };

    if (event.type === "model.message" && event.toolCalls) {
      for (const call of event.toolCalls) {
        const summary = describeToolCall(call);
        const callKey = `tool:${call.id}`;
        pendingCalls[call.id] = callKey;
        entries = upsert(entries, {
          key: callKey,
          stage,
          kind: "tool",
          title: summary.server ? `${summary.name} on ${summary.server}` : summary.name,
          text: "",
          detail: summary.intent ?? summary.argsJson,
        });
      }
    }

    return {
      entries,
      stage,
      pendingCalls,
      messageText: { ...state.messageText, [event.id]: text },
    };
  }

  if (event.type === "tool.response") {
    // The response names no tool, only the call it answers, so the only way to
    // know what came back is to find the call that asked.
    const key = state.pendingCalls[event.toolCallId];
    const existing = key ? state.entries.find((entry) => entry.key === key) : undefined;
    if (!existing) {
      return state;
    }
    return { ...state, entries: upsert(state.entries, { ...existing, settled: true }) };
  }

  return {
    ...state,
    entries: [
      ...state.entries,
      {
        key: `evt:${event.id}`,
        stage: anchoredStage(event.type),
        kind: "event",
        title: event.type,
        text: "",
      },
    ],
  };
}

export interface PendingApproval {
  threadId: string;
  toolCallId: string;
  sourceEventId?: string;
}

/**
 * A turn ends in one of three terminal states, and all three arrive as
 * `turn.done`. Only `done` produced a case. An error or a cancellation carries
 * no output, so reading a receipt off it presents a failed run as a finished
 * one — with the agent's last sentence standing in for a result it never
 * reached.
 */
export function terminalFailure(event: TrueForgeApi.TurnDoneEvent): string | null {
  const state = event.state;
  if (state.status === "error") {
    return state.message || "The harness ended the turn with an error.";
  }
  if (state.status === "cancelled") {
    return `The turn was cancelled: ${state.reason}.`;
  }
  return null;
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
