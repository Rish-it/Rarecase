import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CaseRunner } from "@/components/case-runner";

// Without vitest globals, testing-library cannot clean up after itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Builds an SSE response from groups of frames, one network chunk per group.
 * Grouping matters: the harness emits the pause and the turn's terminal event
 * microseconds apart, so they routinely land in the browser together.
 */
function sseResponse(chunks: unknown[][]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frames of chunks) {
        controller.enqueue(
          encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const started = { type: "case.started", sessionId: "sess_01" };

/** The wrapper the harness actually puts on the wire for an MCP call. */
const modelMessage = {
  id: "msg_2",
  type: "model.message",
  createdAt: "2026-08-26T00:00:02Z",
  threadId: "main",
  content: "Creating the branch.",
  toolCalls: [
    {
      id: "call_9",
      type: "function",
      function: {
        name: "call_tool",
        arguments:
          '{"mcp_server":"github","tool_name":"create_branch","input":{"branch":"gate-test"}}',
      },
      toolInfo: { type: "truefoundry-system", name: "call_tool" },
    },
  ],
};

const approvalRequired = {
  id: "evt_apr",
  type: "tool.approval_required",
  createdAt: "2026-08-26T00:00:03Z",
  threadId: "main",
  toolCalls: [{ id: "call_9", sourceEventId: "msg_2" }],
};

const pausedTurnDone = {
  id: "evt_done",
  type: "turn.done",
  createdAt: "2026-08-26T00:00:03Z",
  threadId: null,
  state: {
    status: "done",
    completedAt: "2026-08-26T00:00:03Z",
    output: null,
    requiredActions: [approvalRequired],
  },
};

function finishedTurnDone(text: string) {
  return {
    id: "evt_done_2",
    type: "turn.done",
    createdAt: "2026-08-26T00:00:09Z",
    threadId: null,
    state: {
      status: "done",
      completedAt: "2026-08-26T00:00:09Z",
      output: { ...modelMessage, id: "msg_3", content: text, toolCalls: undefined },
      requiredActions: [],
    },
  };
}

function openCase() {
  fireEvent.change(screen.getByPlaceholderText(/production failure/i), {
    target: { value: "create a branch" },
  });
  fireEvent.click(screen.getByRole("button", { name: /open case/i }));
}

describe("CaseRunner", () => {
  it("keeps the approval card up when the paused turn reports done in the same chunk", async () => {
    // The exact sequence the harness produces: a turn that pauses still emits
    // turn.done, listing the decision it is waiting on. Treating that as the
    // end of the case retires the card in the render that raised it.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(sseResponse([[started, modelMessage, approvalRequired, pausedTurnDone]]));
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseRunner />);
    openCase();

    expect(await screen.findByLabelText(/pending approval/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^deny$/i })).toBeInTheDocument();
  });

  it("names the tool behind the wrapper and the server it reaches", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sseResponse([[started, modelMessage, approvalRequired, pausedTurnDone]]),
        ),
    );

    render(<CaseRunner />);
    openCase();

    expect(await screen.findByText(/create_branch/)).toBeInTheDocument();
    expect(screen.getByText(/on github/)).toBeInTheDocument();
    expect(screen.queryByText(/call_tool/)).not.toBeInTheDocument();
  });

  it("raises a second card when the resumed turn pauses again", async () => {
    // A case that reaches a pull request pauses at every write along the way,
    // so surviving exactly one decision is not enough.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([[started, modelMessage, approvalRequired, pausedTurnDone]]),
      )
      .mockResolvedValueOnce(sseResponse([[modelMessage, approvalRequired, pausedTurnDone]]));
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseRunner />);
    openCase();

    fireEvent.click(await screen.findByRole("button", { name: /allow/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText(/pending approval/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends the denial to the approve endpoint and reports what was not written", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sseResponse([[started, modelMessage, approvalRequired, pausedTurnDone]]),
      )
      .mockResolvedValueOnce(
        sseResponse([[finishedTurnDone("Denied create_branch; nothing was written.")]]),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<CaseRunner />);
    openCase();

    fireEvent.click(await screen.findByRole("button", { name: /^deny$/i }));
    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: "wrong repo" } });
    fireEvent.click(screen.getByRole("button", { name: /^confirm deny$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("/api/case/sess_01/approve");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      threadId: "main",
      toolCallId: "call_9",
      status: "deny",
      reason: "wrong repo",
    });

    expect(await screen.findByText(/nothing was written/i)).toBeInTheDocument();
  });
});
