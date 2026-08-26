import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { ApprovalCard } from "@/components/approval-card";
import {
  applyEvent,
  buildReceipt,
  describeToolCall,
  emptyTimeline,
  extractApproval,
  pendingActions,
  terminalFailure,
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

describe("STAGES", () => {
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
});

describe("applyEvent", () => {
  function replay(events: AnyEvent[]) {
    let state = emptyTimeline();
    for (const event of events) {
      state = applyEvent(state, event);
    }
    return state;
  }

  it("coalesces deltas into one entry instead of one entry per token", () => {
    const state = replay([
      message("Hel"),
      delta("lo "),
      delta("world"),
      // The transport re-yields the growing base message; identity holds.
      message("Hello world"),
    ]);

    const messageEntries = state.entries.filter((entry) => entry.key === "msg:msg_1");
    expect(messageEntries).toHaveLength(1);
    expect(messageEntries[0]?.text).toBe("Hello world");
  });

  it("keeps unstaged events as their own raw-log entries", () => {
    const state = replay([
      lifecycle("turn.created", "evt_t0"),
      delta("Hel"),
      lifecycle("mcp.initialize", "evt_mcp"),
    ]);

    expect(state.entries.map((entry) => entry.key)).toEqual([
      "evt:evt_t0",
      "msg:msg_1",
      "evt:evt_mcp",
    ]);
    expect(state.entries.every((entry) => entry.stage === null)).toBe(true);
  });

  it("files work under the stage the agent announced, and moves it on the next", () => {
    const state = replay([
      message("**Stage 1: Evidence** reading the issue."),
      lifecycle("mcp.initialize", "evt_mcp"),
      { ...message("**Stage 3: Reproduction** cloning."), id: "msg_2" } as AnyEvent,
    ]);

    expect(state.entries.find((entry) => entry.key === "msg:msg_1")?.stage).toBe("Evidence");
    expect(state.entries.find((entry) => entry.key === "msg:msg_2")?.stage).toBe("Reproduction");
    expect(state.stage).toBe("Reproduction");
  });

  it("anchors a pause to Approval whatever stage was open", () => {
    const pause: TrueForgeApi.ToolApprovalRequiredEvent = {
      id: "evt_apr",
      type: "tool.approval_required",
      createdAt: "2026-08-26T00:00:03Z",
      threadId: "thr_main",
      toolCalls: [{ id: "call_1", sourceEventId: "msg_2" }],
    };
    const state = replay([message("**Stage 1: Evidence** reading."), pause]);

    expect(state.entries.find((entry) => entry.key === "evt:evt_apr")?.stage).toBe("Approval");
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

function turnDone(
  output: TrueForgeApi.ModelMessageEvent | null,
  requiredActions: TrueForgeApi.ActionRequiredEvent[] = [],
): TrueForgeApi.TurnDoneEvent {
  return {
    id: "evt_done",
    type: "turn.done",
    createdAt: "2026-08-26T00:09:00Z",
    threadId: null,
    state: { status: "done", completedAt: "2026-08-26T00:09:00Z", output, requiredActions },
  };
}

describe("buildReceipt", () => {
  it("collects what was written and any pull request link from the final state", () => {
    const receipt = buildReceipt(
      turnDone(
        message("Opened https://github.com/acme/shop/pull/7 fixing checkout in app/cart/page.tsx."),
      ),
    );
    expect(receipt?.text).toContain("fixing checkout");
    expect(receipt?.links).toEqual(["https://github.com/acme/shop/pull/7"]);
  });

  it("stays empty when the turn left nothing behind", () => {
    expect(buildReceipt(turnDone(null))).toBeNull();
  });

  it("falls back to the last thing the agent said when the turn has no output", () => {
    // The shape a denial leaves behind: terminal, but with nothing of its own
    // to report.
    const receipt = buildReceipt(turnDone(null), "Denied create_branch; nothing was written.");

    expect(receipt?.text).toBe("Denied create_branch; nothing was written.");
  });
});

describe("pendingActions", () => {
  it("reports the decision a paused turn is waiting on", () => {
    const paused = turnDone(null, [
      {
        id: "evt_apr",
        type: "tool.approval_required",
        createdAt: "2026-08-26T00:00:03Z",
        threadId: "thr_main",
        toolCalls: [{ id: "call_9", sourceEventId: "msg_2" }],
      },
    ]);

    expect(pendingActions(paused)).toHaveLength(1);
    expect(pendingActions(turnDone(message("done")))).toEqual([]);
  });
});

describe("terminalFailure", () => {
  function terminal(state: unknown): TrueForgeApi.TurnDoneEvent {
    return {
      id: "evt_done",
      type: "turn.done",
      createdAt: "2026-08-26T00:09:00Z",
      threadId: null,
      state,
    } as unknown as TrueForgeApi.TurnDoneEvent;
  }

  it("reports the harness message when the turn errored", () => {
    // The exact shape a failed run produced: turn.done, status error, no
    // output at all. Read as a completed case it would show the agent's last
    // sentence as the result.
    expect(
      terminalFailure(
        terminal({
          status: "error",
          message: "Request failed (500): Internal server error",
          completedAt: "2026-08-26T00:09:00Z",
        }),
      ),
    ).toBe("Request failed (500): Internal server error");
  });

  it("names the reason when the turn was cancelled", () => {
    expect(
      terminalFailure(
        terminal({
          status: "cancelled",
          reason: "server-execution-timeout",
          completedAt: "2026-08-26T00:09:00Z",
        }),
      ),
    ).toBe("The turn was cancelled: server-execution-timeout.");
  });

  it("stays silent for a turn that actually finished", () => {
    expect(terminalFailure(turnDone(message("done")))).toBeNull();
  });
});

describe("describeToolCall", () => {
  function wrapped(args: string): TrueForgeApi.ToolCall {
    return {
      id: "call_9",
      type: "function",
      function: { name: "call_tool", arguments: args },
      toolInfo: { type: "truefoundry-system", name: "call_tool" },
    } as unknown as TrueForgeApi.ToolCall;
  }

  it("names the tool the human is actually approving, not the wrapper", () => {
    // Every MCP call reaches the model as `call_tool`; showing that on the card
    // would tell the human nothing about what is about to happen.
    const summary = describeToolCall(
      wrapped('{"mcp_server":"github","tool_name":"create_branch","input":{"branch":"gate-test"}}'),
    );

    expect(summary.name).toBe("create_branch");
    expect(summary.server).toBe("github");
    expect(summary.argsJson).toContain("gate-test");
  });

  it("shows the raw call when the arguments are not the wrapper envelope", () => {
    const summary = describeToolCall(wrapped("{ truncated"));

    expect(summary.name).toBe("call_tool");
    expect(summary.argsJson).toBe("{ truncated");
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
