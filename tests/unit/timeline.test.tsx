import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { ApprovalCard } from "@/components/approval-card";
import {
  applyTimelineEvent,
  buildReceipt,
  extractApproval,
  mapEventToStage,
  STAGES,
} from "@/lib/timeline";

type AnyEvent = TrueForgeApi.TurnStreamingEvent;

// Without vitest globals, testing-library cannot clean up after itself.
afterEach(cleanup);

function lifecycle(type: AnyEvent["type"], id = "evt_1"): AnyEvent {
  return {
    id,
    type,
    createdAt: "2026-08-26T00:00:00Z",
  } as unknown as AnyEvent;
}

function sandboxCreated(): AnyEvent {
  return {
    id: "evt_sbx",
    type: "sandbox.created",
    createdAt: "2026-08-26T00:00:01Z",
    sandbox: { id: "sbx_1" },
  } as unknown as AnyEvent;
}

function message(text: string): TrueForgeApi.ModelMessageEvent {
  return {
    id: "msg_1",
    type: "model.message",
    createdAt: "2026-08-26T00:00:02Z",
    threadId: "thr_main",
    content: text,
  };
}

function delta(text: string): TrueForgeApi.ModelMessageDeltaEvent {
  return { id: "msg_1", type: "model.message.delta", threadId: "thr_main", content: text };
}

describe("mapEventToStage", () => {
  it("names the eight protocol stages in order", () => {
    expect(STAGES).toEqual([
      "Evidence",
      "Hypothesis",
      "Reproduction",
      "Diagnosis",
      "Patch",
      "Verification",
      "Approval",
      "Receipt",
    ]);
  });

  it("maps sandbox creation to Reproduction and a pause to Approval", () => {
    expect(mapEventToStage(sandboxCreated())).toBe("Reproduction");

    const pause: TrueForgeApi.ToolApprovalRequiredEvent = {
      id: "evt_apr",
      type: "tool.approval_required",
      createdAt: "2026-08-26T00:00:03Z",
      threadId: "thr_main",
      toolCalls: [{ id: "call_1", sourceEventId: "msg_2" }],
    };
    expect(mapEventToStage(pause)).toBe("Approval");
  });

  it("refuses to invent stages for events that have none", () => {
    for (const type of [
      "turn.created",
      "thread.created",
      "thread.done",
      "mcp.initialize",
      "mcp.auth_required",
      "tool.response_required",
      "tool.response",
      "model.message",
    ] as const) {
      expect(mapEventToStage(lifecycle(type))).toBeNull();
    }
  });
});

describe("applyTimelineEvent", () => {
  it("coalesces deltas into one entry instead of one entry per token", () => {
    let entries = applyTimelineEvent([], message("Hel"));
    expect(entries).toHaveLength(1);
    entries = applyTimelineEvent(entries, delta("lo "));
    entries = applyTimelineEvent(entries, delta("world"));
    // The transport re-yields the growing base message; identity holds.
    entries = applyTimelineEvent(entries, message("Hello world"));

    const messageEntries = entries.filter((entry) => entry.key === "msg:msg_1");
    expect(messageEntries).toHaveLength(1);
    expect(messageEntries[0]?.text).toBe("Hello world");
  });

  it("keeps unrelated events as their own raw-log entries", () => {
    let entries = applyTimelineEvent([], lifecycle("turn.created", "evt_t0"));
    entries = applyTimelineEvent(entries, delta("Hel"));
    entries = applyTimelineEvent(entries, lifecycle("mcp.initialize", "evt_mcp"));

    expect(entries.map((entry) => entry.key)).toEqual(["evt:evt_t0", "msg:msg_1", "evt:evt_mcp"]);
  });
});

describe("extractApproval", () => {
  it("exposes the paused thread and tool call for the decision", () => {
    const pause: TrueForgeApi.ToolApprovalRequiredEvent = {
      id: "evt_apr",
      type: "tool.approval_required",
      createdAt: "2026-08-26T00:00:03Z",
      threadId: "thr_main",
      toolCalls: [{ id: "call_9", sourceEventId: "msg_2" }],
    };

    expect(extractApproval(pause)).toEqual({
      threadId: "thr_main",
      toolCallId: "call_9",
      sourceEventId: "msg_2",
    });
    expect(extractApproval(message("hi"))).toBeNull();
  });
});

describe("buildReceipt", () => {
  it("collects what was written and any pull request link from the final state", () => {
    const done: TrueForgeApi.TurnDoneEvent = {
      id: "evt_done",
      type: "turn.done",
      createdAt: "2026-08-26T00:09:00Z",
      threadId: null,
      state: {
        status: "done",
        completedAt: "2026-08-26T00:09:00Z",
        output: message(
          "Opened https://github.com/acme/shop/pull/7 fixing checkout in app/cart/page.tsx.",
        ),
        requiredActions: [],
      },
    };

    const receipt = buildReceipt(done);
    expect(receipt?.text).toContain("fixing checkout");
    expect(receipt?.links).toEqual(["https://github.com/acme/shop/pull/7"]);
  });

  it("stays empty when the turn left nothing behind", () => {
    const done: TrueForgeApi.TurnDoneEvent = {
      id: "evt_done",
      type: "turn.done",
      createdAt: "2026-08-26T00:09:00Z",
      threadId: null,
      state: {
        status: "done",
        completedAt: "2026-08-26T00:09:00Z",
        output: null,
        requiredActions: [],
      },
    };
    expect(buildReceipt(done)).toBeNull();
  });
});

describe("ApprovalCard", () => {
  const pending = {
    threadId: "thr_main",
    toolCallId: "call_9",
    sourceEventId: "msg_2",
    name: "create_pull_request",
    argsJson: '{"title":"Fix double submit"}',
  };

  it("renders the pending tool name and both decisions", () => {
    render(<ApprovalCard pending={pending} busy={false} onDecide={() => {}} />);

    expect(screen.getByText(/create_pull_request/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("falls back to the tool call id when the name is unknown", () => {
    render(
      <ApprovalCard
        pending={{ ...pending, name: undefined, argsJson: undefined }}
        busy={false}
        onDecide={() => {}}
      />,
    );

    expect(screen.getByText(/call_9/)).toBeInTheDocument();
  });

  it("sends allow straight through", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard pending={pending} busy={false} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: /allow/i }));

    expect(onDecide).toHaveBeenCalledWith({ status: "allow" });
  });

  it("attaches the typed reason when denying", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard pending={pending} busy={false} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    fireEvent.change(screen.getByPlaceholderText(/reason/i), {
      target: { value: "wrong repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^confirm deny$/i }));

    expect(onDecide).toHaveBeenCalledWith({ status: "deny", reason: "wrong repo" });
  });

  it("disables the decisions while a decision is in flight", () => {
    render(<ApprovalCard pending={pending} busy onDecide={() => {}} />);

    expect(screen.getByRole("button", { name: /allow/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deny/i })).toBeDisabled();
  });
});
