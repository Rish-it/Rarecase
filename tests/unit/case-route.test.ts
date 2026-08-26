// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { POST as approveTurn } from "@/app/api/case/[sessionId]/approve/route";
import { POST as startCase } from "@/app/api/case/route";

type AnyEvent = TrueForgeApi.TurnStreamingEvent;
type MessageEvent = TrueForgeApi.ModelMessageEvent;

// The routes must ride on the transport from the previous phase, never their
// own; mocking it also keeps every test off the network.
const { openCase, decide } = vi.hoisted(() => ({
  openCase: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ openCase, decide }));

function message(text: string): MessageEvent {
  return {
    id: "msg_1",
    type: "model.message",
    createdAt: "2026-08-26T00:00:00Z",
    threadId: "thr_main",
    content: text,
  };
}

function turnDone(): TrueForgeApi.TurnDoneEvent {
  return {
    id: "evt_done",
    type: "turn.done",
    createdAt: "2026-08-26T00:00:02Z",
    state: {
      status: "done",
      completedAt: "2026-08-26T00:00:02Z",
      output: null,
      requiredActions: [],
    },
    threadId: null,
  };
}

async function* streamOf(...events: AnyEvent[]): AsyncGenerator<AnyEvent> {
  for (const event of events) {
    yield event;
  }
}

function jsonRequest(url: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

function frames(sseText: string): unknown[] {
  return sseText
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      expect(frame).toMatch(/^data: /);
      return JSON.parse(frame.slice("data: ".length));
    });
}

describe("POST /api/case", () => {
  it("rejects a body without a prompt before touching the harness", async () => {
    const response = await startCase(jsonRequest("http://localhost/api/case", {}));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/prompt/i);
    expect(openCase).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await startCase(
      new Request("http://localhost/api/case", { method: "POST", body: "not json" }),
    );

    expect(response.status).toBe(400);
  });

  it("streams the session id first, then harness events as SSE frames", async () => {
    openCase.mockResolvedValue({
      sessionId: "sess_01",
      events: streamOf(message("Hel"), turnDone()),
    });

    const response = await startCase(
      jsonRequest("http://localhost/api/case", { prompt: "checkout double-submits" }),
    );

    expect(openCase).toHaveBeenCalledWith("checkout double-submits");
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const seen = frames(await response.text());
    expect(seen[0]).toEqual({ type: "case.started", sessionId: "sess_01" });
    expect(seen[1]).toMatchObject({ type: "model.message", content: "Hel" });
  });

  it("closes the stream on turn.done and drops whatever follows", async () => {
    let yieldedPastDone = false;
    async function* events(): AsyncGenerator<AnyEvent> {
      yield turnDone();
      yieldedPastDone = true;
      yield message("never streamed");
    }
    openCase.mockResolvedValue({ sessionId: "sess_01", events: events() });

    const response = await startCase(jsonRequest("http://localhost/api/case", { prompt: "go" }));
    const seen = frames(await response.text());

    expect(seen.at(-1)).toMatchObject({ type: "turn.done" });
    expect(yieldedPastDone).toBe(false);
  });

  it("stops iterating upstream when the client disconnects", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let firstSent!: () => void;
    const firstGate = new Promise<void>((resolve) => (firstSent = resolve));

    async function* slowStream(): AsyncGenerator<AnyEvent> {
      yield message("before drop");
      firstSent();
      await secondGate;
      yield message("after drop");
    }
    openCase.mockResolvedValue({ sessionId: "sess_01", events: slowStream() });

    const controller = new AbortController();
    const pendingText = startCase(
      jsonRequest("http://localhost/api/case", { prompt: "go" }, controller.signal),
    ).then((response) => response.text());

    await firstGate;
    controller.abort();
    releaseSecond();

    const text = await pendingText;
    expect(text).toContain("before drop");
    expect(text).not.toContain("after drop");
  });

  it("answers a harness failure with a shaped error and no upstream body", async () => {
    const failure = Object.assign(new Error("harness unreachable"), {
      body: { token: "tf_secret_value" },
    });
    openCase.mockRejectedValue(failure);

    const response = await startCase(jsonRequest("http://localhost/api/case", { prompt: "go" }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("harness unreachable");
    expect(JSON.stringify(body)).not.toContain("tf_secret_value");
  });
});

describe("POST /api/case/[sessionId]/approve", () => {
  const url = "http://localhost/api/case/sess_01/approve";

  it("rejects a status outside allow and deny before resuming", async () => {
    const response = await approveTurn(
      jsonRequest(url, { threadId: "thr_main", toolCallId: "call_1", status: "maybe" }),
      { params: Promise.resolve({ sessionId: "sess_01" }) },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/status/i);
    expect(decide).not.toHaveBeenCalled();
  });

  it("resumes the addressed session with the parsed decision", async () => {
    decide.mockResolvedValue(streamOf(turnDone()));

    const response = await approveTurn(
      jsonRequest(url, { threadId: "thr_main", toolCallId: "call_1", status: "allow" }),
      { params: Promise.resolve({ sessionId: "sess_42" }) },
    );

    expect(decide).toHaveBeenCalledWith("sess_42", {
      threadId: "thr_main",
      toolCallId: "call_1",
      status: "allow",
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(frames(await response.text())[0]).toMatchObject({
      id: "evt_done",
      type: "turn.done",
    });
  });

  it("carries a denial reason through to the transport", async () => {
    decide.mockResolvedValue(streamOf(turnDone()));

    await approveTurn(
      jsonRequest(url, {
        threadId: "thr_main",
        toolCallId: "call_1",
        status: "deny",
        reason: "wrong repo",
      }),
      { params: Promise.resolve({ sessionId: "sess_01" }) },
    );

    expect(decide).toHaveBeenCalledWith("sess_01", {
      threadId: "thr_main",
      toolCallId: "call_1",
      status: "deny",
      reason: "wrong repo",
    });
  });
});
