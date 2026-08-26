"use client";

import { useState } from "react";
import type { PendingApproval } from "@/lib/timeline";

export interface ResolvedPending extends PendingApproval {
  name?: string;
  argsJson?: string;
}

interface ApprovalCardProps {
  pending: ResolvedPending;
  busy: boolean;
  onDecide: (decision: { status: "allow" | "deny"; reason?: string }) => void;
}

/**
 * The centrepiece of the case file: the exact external action the agent wants
 * to take, and the human's allow/deny verdict on it. Denial takes an optional
 * reason that rides back to the agent.
 */
export function ApprovalCard({ pending, busy, onDecide }: ApprovalCardProps) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <section
      aria-label="Pending approval"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
    >
      <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
        Waiting for your decision
      </h3>

      <p className="mt-2 font-mono text-sm break-all">
        {pending.name ?? `unknown tool call ${pending.toolCallId}`}
      </p>

      {pending.argsJson ? (
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
          {pending.argsJson}
        </pre>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide({ status: "allow" })}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Allow
        </button>
        {!denying ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDenying(true)}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Deny
          </button>
        ) : (
          <>
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (optional)"
              className="w-48 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDenying(false);
                onDecide({ status: "deny", reason: reason || undefined });
                setReason("");
              }}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Confirm deny
            </button>
          </>
        )}
      </div>
    </section>
  );
}
