"use client";

import { useCallback, useRef, useState } from "react";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { ApprovalCard, type ResolvedPending } from "@/components/approval-card";
import {
  applyTimelineEvent,
  buildReceipt,
  contentToText,
  describeToolCall,
  extractApproval,
  pendingActions,
  STAGES,
  type CaseReceipt,
  type TimelineEntry,
} from "@/lib/timeline";

type StreamEvent =
  | { type: "case.started"; sessionId: string }
  | { type: "stream.error"; error: string }
  | TrueForgeApi.TurnStreamingEvent;

type Phase = "idle" | "running" | "awaiting" | "done" | "error";

/**
 * Reads an SSE response body and hands each parsed event to `onEvent`.
 * Frames can split across chunks, so bytes buffer until a full `\n\n` boundary.
 */
async function consumeSse(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (!response.ok || !response.body) {
    const problem = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(problem?.error ?? `Request failed with status ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          onEvent(JSON.parse(frame.slice("data: ".length)) as StreamEvent);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function CaseRunner() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [prompt, setPrompt] = useState("");
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [pending, setPending] = useState<ResolvedPending | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [receipt, setReceipt] = useState<CaseReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tool names and arguments live on the model.message that requested the
  // call; the pause event only carries ids. Keep both keyed for resolution.
  const toolCallsBySourceEvent = useRef(new Map<string, TrueForgeApi.ToolCall[]>());
  const sessionIdRef = useRef<string | null>(null);
  const activeStream = useRef<AbortController | null>(null);
  // A turn can end with no output of its own — after a denial, most of all —
  // so the last thing the agent said stands in as the receipt.
  const narration = useRef("");

  const handleEvent = useCallback((event: StreamEvent) => {
    if ("type" in event && event.type === "case.started") {
      sessionIdRef.current = event.sessionId;
      return;
    }
    if ("type" in event && event.type === "stream.error") {
      setError(event.error);
      setPhase("error");
      return;
    }

    if (event.type === "model.message") {
      if (event.toolCalls) {
        toolCallsBySourceEvent.current.set(event.id, event.toolCalls);
      }
      const text = contentToText(event.content);
      if (text) {
        narration.current = text;
      }
    }
    setEntries((current) => applyTimelineEvent(current, event));

    if (event.type === "tool.approval_required") {
      const approval = extractApproval(event);
      if (approval) {
        const calls = approval.sourceEventId
          ? toolCallsBySourceEvent.current.get(approval.sourceEventId)
          : undefined;
        const call = calls?.find((candidate) => candidate.id === approval.toolCallId);
        setPending({ ...approval, ...(call ? describeToolCall(call) : {}) });
        setPhase("awaiting");
      }
      return;
    }

    if (event.type === "turn.done") {
      // A paused turn still reports done, listing the decision it is waiting
      // on. Closing the case here would retire the approval card in the same
      // render it was raised in, and the gate would never be seen.
      if (pendingActions(event).length > 0) {
        return;
      }
      setPending(null);
      setReceipt(buildReceipt(event, narration.current));
      setPhase("done");
    }
  }, []);

  const startCase = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    setEntries([]);
    setPending(null);
    setReceipt(null);
    setError(null);
    setPhase("running");
    toolCallsBySourceEvent.current.clear();
    narration.current = "";

    const controller = new AbortController();
    activeStream.current = controller;
    try {
      await consumeSse(
        await fetch("/api/case", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: trimmed }),
          signal: controller.signal,
        }),
        handleEvent,
      );
    } catch (streamError) {
      if (!controller.signal.aborted) {
        setError(streamError instanceof Error ? streamError.message : String(streamError));
        setPhase("error");
      }
    } finally {
      if (activeStream.current === controller) {
        activeStream.current = null;
      }
    }
  }, [handleEvent, prompt]);

  const decide = useCallback(
    async (decision: { status: "allow" | "deny"; reason?: string }) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || !pending) {
        return;
      }
      const controller = new AbortController();
      activeStream.current = controller;
      setDeciding(true);
      // This decision is spent. The resumed turn raises its own card if it
      // pauses again, and a case that reaches a pull request pauses at every
      // write along the way.
      setPending(null);
      setPhase("running");
      try {
        await consumeSse(
          await fetch(`/api/case/${sessionId}/approve`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              threadId: pending.threadId,
              toolCallId: pending.toolCallId,
              ...decision,
            }),
            signal: controller.signal,
          }),
          handleEvent,
        );
      } catch (streamError) {
        if (!controller.signal.aborted) {
          setError(streamError instanceof Error ? streamError.message : String(streamError));
          setPhase("error");
        }
      } finally {
        setDeciding(false);
        if (activeStream.current === controller) {
          activeStream.current = null;
        }
      }
    },
    [handleEvent, pending],
  );

  const stageEntries = (stage: (typeof STAGES)[number]) =>
    entries.filter((entry) => entry.stage === stage);
  const rawEntries = entries.filter((entry) => entry.stage === null && entry.kind === "event");

  return (
    <div className="mt-10">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void startCase();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the production failure…"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={phase === "running" || phase === "awaiting"}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Open case
        </button>
      </form>

      {phase !== "idle" ? (
        <ol className="mt-8 space-y-6">
          {STAGES.map((stage) => {
            const stageOwn = stageEntries(stage);
            return (
              <li
                key={stage}
                className="border-l-2 border-neutral-200 pl-4 dark:border-neutral-800"
              >
                <h2 className="text-sm font-semibold tracking-wide text-neutral-500 uppercase">
                  {stage}
                </h2>
                {stageOwn.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {stageOwn.map((entry) => (
                      <li key={entry.key} className="text-sm">
                        <span className="font-mono text-xs text-neutral-400">{entry.title}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-neutral-400">—</p>
                )}
                {stage === "Approval" && pending ? (
                  <div className="mt-2">
                    <ApprovalCard
                      pending={pending}
                      busy={deciding}
                      onDecide={(decision) => void decide(decision)}
                    />
                  </div>
                ) : null}
                {stage === "Receipt" && receipt ? (
                  <div className="mt-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                    <p className="text-sm whitespace-pre-wrap">{receipt.text}</p>
                    {receipt.links.map((link) => (
                      <a
                        key={link}
                        href={link}
                        className="mt-1 block text-sm text-sky-600 underline dark:text-sky-400"
                      >
                        {link}
                      </a>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {rawEntries.length > 0 ? (
        <details className="mt-8">
          <summary className="cursor-pointer text-sm font-medium text-neutral-500">
            Raw events ({rawEntries.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {rawEntries.map((entry) => (
              <li key={entry.key} className="font-mono text-xs text-neutral-400">
                {entry.title}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {entries.some((entry) => entry.kind === "message" && entry.text) ? (
        <section className="mt-8 space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-neutral-500 uppercase">
            Agent narration
          </h2>
          {entries
            .filter((entry) => entry.kind === "message" && entry.text)
            .map((entry) => (
              <p key={entry.key} className="text-sm whitespace-pre-wrap">
                {entry.text}
              </p>
            ))}
        </section>
      ) : null}

      {phase === "error" && error ? (
        <p
          role="alert"
          data-testid="stream-error"
          className="mt-6 rounded-md bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
