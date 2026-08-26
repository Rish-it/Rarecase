import { describe, expect, it, vi } from "vitest";
import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { decide, isApprovalRequired, openCase } from "@/lib/session";

type AnyEvent = TrueForgeApi.TurnStreamingEvent;
type MessageEvent = TrueForgeApi.ModelMessageEvent;

function message(text: string): MessageEvent {
  return {
    id: "msg_1",
    type: "model.message",
    createdAt: "2026-08-26T00:00:00Z",
    threadId: "thr_main",
    content: text,
  };
}

function delta(id: string, text: string): TrueForgeApi.ModelMessageDeltaEvent {
  return {
    id,
    type: "model.message.delta",
    threadId: "thr_main",
    content: text,
  };
}

const approvalRequired: TrueForgeApi.ToolApprovalRequiredEvent = {
  id: "evt_apr_1",
  type: "tool.approval_required",
  createdAt: "2026-08-26T00:00:01Z",
  threadId: "thr_main",
  toolCalls: [{ id: "call_1", sourceEventId: "msg_2" }],
};

/**
 * A stand-in for the harness client: records every turn request so tests can
 * assert on the exact input items the wrapper sends. No network anywhere.
 */
function fakeClient(options: { sessionId?: string; events?: AnyEvent[] } = {}) {
  const sessionId = options.sessionId ?? "sess_01";
  const create = vi.fn(async () => ({ data: { id: sessionId } }));
  const createTurnStream = vi.fn<
    (sessionId: string, request: { input: unknown[] }) => Promise<AsyncGenerator<AnyEvent, void>>
  >(async () => {
    async function* stream(): AsyncGenerator<AnyEvent> {
      for (const event of options.events ?? []) {
        yield event;
      }
    }
    return stream();
  });
  const client = { sessions: { create, createTurnStream } } as unknown as TrueForge;
  return { client, create, createTurnStream };
}

async function collect(events: AsyncIterable<AnyEvent>): Promise<AnyEvent[]> {
  const seen: AnyEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

describe("openCase", () => {
  it("creates a rarecase session and streams its first user turn", async () => {
    const { client, create, createTurnStream } = fakeClient();

    const result = await openCase("checkout double-submits", client);

    expect(create).toHaveBeenCalledWith({ agent: { name: "rarecase" } });
    expect(result.sessionId).toBe("sess_01");
    expect(createTurnStream).toHaveBeenCalledWith("sess_01", {
      input: [{ type: "user.message", content: "checkout double-submits" }],
    });
    await collect(result.events);
  });

  it("coalesces message deltas into their base model.message", async () => {
    const { client } = fakeClient({
      events: [message("Hel"), delta("msg_1", "lo"), approvalRequired, delta("msg_1", "!")],
    });

    const { events } = await openCase("reproduce it", client);
    const seen = await collect(events);

    // Raw deltas never leak out of the transport.
    expect(seen.filter((event) => event.type === "model.message.delta")).toHaveLength(0);

    // The base is yielded on arrival and re-yielded after each merge; unrelated
    // events pass through untouched between them.
    expect(seen.map((event) => event.type)).toEqual([
      "model.message",
      "model.message",
      "tool.approval_required",
      "model.message",
    ]);

    const final = seen.at(-1) as MessageEvent;
    expect(final.content).toBe("Hello!");
  });

  it("rejects an empty prompt before contacting the harness", async () => {
    const { client, create } = fakeClient();

    await expect(openCase("", client)).rejects.toThrow(/prompt/i);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("isApprovalRequired", () => {
  it("detects a paused turn and exposes the pending tool call", () => {
    expect(isApprovalRequired(approvalRequired)).toBe(true);

    if (!isApprovalRequired(approvalRequired)) {
      expect.unreachable();
    }
    expect(approvalRequired.threadId).toBe("thr_main");
    expect(approvalRequired.toolCalls[0]?.id).toBe("call_1");
  });

  it("does not match ordinary events", () => {
    expect(isApprovalRequired(message("Hello!"))).toBe(false);
  });
});

describe("decide", () => {
  it("resumes the paused turn with a camelCase tool-approval input", async () => {
    const { client, createTurnStream } = fakeClient();

    const events = await decide(
      "sess_01",
      { threadId: "thr_main", toolCallId: "call_1", status: "allow" },
      client,
    );

    expect(createTurnStream).toHaveBeenCalledWith("sess_01", {
      input: [
        {
          type: "user.tool_approval",
          threadId: "thr_main",
          toolCallId: "call_1",
          approval: { status: "allow" },
        },
      ],
    });
    await collect(events);
  });

  it("carries a denial reason through to the harness", async () => {
    const { client, createTurnStream } = fakeClient();

    await collect(
      await decide(
        "sess_01",
        { threadId: "thr_main", toolCallId: "call_1", status: "deny", reason: "wrong repo" },
        client,
      ),
    );

    expect(createTurnStream.mock.calls[0]?.[1].input).toEqual([
      {
        type: "user.tool_approval",
        threadId: "thr_main",
        toolCallId: "call_1",
        approval: { status: "deny", reason: "wrong repo" },
      },
    ]);
  });

  it("rejects a decision with an empty tool call id before contacting the harness", async () => {
    const { client, createTurnStream } = fakeClient();

    await expect(
      decide("sess_01", { threadId: "thr_main", toolCallId: "", status: "allow" }, client),
    ).rejects.toThrow(/toolCallId/i);
    expect(createTurnStream).not.toHaveBeenCalled();
  });
});
