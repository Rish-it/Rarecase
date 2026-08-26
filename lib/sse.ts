import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

/**
 * Server-only. Frames harness event streams as Server-Sent Events for the
 * browser. One `data:` line per event, JSON on a single line; the stream ends
 * at `turn.done`, when the client disconnects, or when the harness fails.
 */

export interface CaseStartedEvent {
  type: "case.started";
  sessionId: string;
}

export interface StreamErrorEvent {
  type: "stream.error";
  error: string;
}

/**
 * Same posture as readHarnessStatus: the error message is safe to show, the
 * raw upstream body is not — it can carry harness-side detail that must never
 * reach the browser.
 */
export function harnessErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps an upstream event iterable in an SSE response. The preamble lets a
 * route lead the stream with its own event (the case route announces the
 * session id first so the client can address later requests).
 *
 * A dropped browser tab aborts `signal`, which stops pulling from upstream:
 * the turn stops streaming instead of running to completion unseen.
 */
export function sseResponse(
  events: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  options: { signal?: AbortSignal; preamble?: CaseStartedEvent } = {},
): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown): void => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = (): void => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      if (options.signal?.aborted) {
        return close();
      }

      try {
        if (options.preamble) {
          send(options.preamble);
        }

        for await (const event of events) {
          if (options.signal?.aborted) {
            break;
          }
          send(event);
          if (event.type === "turn.done") {
            break;
          }
        }
      } catch (error) {
        // Headers are already gone, so a mid-stream failure rides the stream
        // itself as one final renderable event.
        send({
          type: "stream.error",
          error: harnessErrorMessage(error),
        } satisfies StreamErrorEvent);
      }

      close();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
