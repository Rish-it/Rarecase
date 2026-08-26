# Rarecase

> An agent that will tell you it could not prove the fix, and stop.

Rarecase takes one GitHub issue and produces an inspectable chain: evidence, hypothesis, reproduction, diagnosis, patch, verification, approval, receipt. Every stage is visible while it happens, and every claim in it is either cited or labelled a guess.

The hard part of a debugging agent is not doing the work. It is refusing to say the work succeeded when it did not.

## What it refuses to do

Three rules are enforced by [the protocol the agent loads](skills/rarecase-debugging/SKILL.md) before every case:

**A claim you cannot cite is a hypothesis, and it is labelled one.** A citation is a repository location with a line number, a commit SHA, a quoted line from the issue, a sandbox observation, or a test result. Nothing else counts.

**No product code is edited until a test fails for the reported reason.** A plausible fix without a reproduction is a guess. If reproduction fails, the case stops and reports what evidence is missing.

**A fix is verified only when the same unmodified test fails on the base revision and passes on the patched tree.** Editing the test to fit the patch voids the proof and must be reported as a failure.

Stopping with an honest account of a missing link is a successful outcome. Fabricating the missing link is the one failure the protocol exists to prevent.

## The gate

Investigation is autonomous. Mutation is not.

Every external write pauses. The interface names the exact call — the tool, the server it reaches, the arguments it will send — and waits for Allow or Deny. A denial ends the case: the agent records it and stops, rather than retrying or reaching the same effect with a different tool.

This is verified against GitHub itself, not against the interface. The end-to-end test denies a `create_branch` and then asks GitHub whether the branch exists; a `404` is the assertion. Checking that a card disappeared would prove only that React re-rendered.

## Stages are a cursor, not a lookup

Mapping tool names to stages cannot work, and the recordings show why. Hypothesis and Diagnosis run **no tools at all** — they are reasoning, and a table keyed on tool name leaves them empty forever. Reproduction and Verification are the **same command against the same sandbox**; only position in the sequence separates them.

So the agent announces each stage as it enters one, and work that follows belongs to whichever stage is open. Tool identity became content rather than routing.

Two details that only a real recording would teach you. The agent's own marker format drifts — `**Stage 1: Evidence**` in one run, `**Stage 1 — Evidence**` in the next, from identical instructions — so the skill mandates a literal form and the parser tolerates both. And the cursor reads the agent's messages only, never tool output: the agent reads the protocol file on every run, and that file contains a stage marker as its own example.

## Architecture

The Next.js app is the only process that talks to the harness. It holds no model, GitHub, or sandbox credential of its own.

| Layer                 | Choice                                                            |
| --------------------- | ----------------------------------------------------------------- |
| Product app           | Next.js App Router, React 19, TypeScript strict, Tailwind 4       |
| Input validation      | Zod at every trust boundary, including the environment            |
| Agent runtime         | TrueForge server and `@truefoundry/trueforge-sdk`                 |
| Reusable instructions | Git-backed `skills/rarecase-debugging/SKILL.md`                   |
| External systems      | GitHub MCP, with `@write` and `@destructive` gated                |
| Isolated execution    | TrueForge sandbox-as-tool                                         |
| Transport             | Server-sent events, one frame per harness event                   |
| Tests                 | Vitest against a recorded case, Playwright against a live harness |
| Local runtime         | Node.js 22.14+, pnpm, TrueForge in SQLite mode                    |

A turn that pauses for a human still reports `turn.done`, listing the decision it is waiting on — treating that as the end of the case would retire the approval card in the same render that raised it. A turn also ends `error` or `cancelled` through the same event, and reading a receipt off those presented a dead run as a finished one.

## Tested against a recording, not against the types

`tests/fixtures/full-case.jsonl` is a real run against a live harness, investigating a real issue in this repository. The unit suite replays it.

This matters because the alternative failed. Five protocol stages shipped dead behind a green suite that modelled a harness nobody had observed. Every routing rule here is now justified by a frame in that file, and rules the recording cannot support are left unimplemented rather than guessed.

The tests are checked by breaking the implementation and confirming they fail: disabling the stage cursor, re-anchoring `sandbox.created`, letting the cursor read tool output, and restoring the raw-log filter each take down a different assertion.

## Getting started

Requires Node.js 22.14 or newer, pnpm, and a TrueForge harness.

```bash
npx @truefoundry/trueforge      # harness on http://localhost:8790
pnpm install
cp .env.example .env.local      # harness location only
pnpm dev                        # http://localhost:3000
```

```bash
pnpm verify         # format, lint, typecheck, unit tests
pnpm test:e2e       # Playwright, mobile Chromium at 390x844
pnpm build
```

Playwright needs its browser once: `pnpm exec playwright install chromium`.

The end-to-end suite drives a real case against a live harness and costs a few minutes of model work per run. It skips only when nothing answers at the harness address; a harness that answers but misbehaves fails loudly.

## Where it stands

Working and tested end to end: the harness connection, the session transport, the case API, the sandbox, the stage chain rendering live, the approval gate, and a denial confirmed against GitHub rather than against local state.

**Not yet achieved: a full case reaching an approved pull request.** Four attempts, four upstream failures — an HTTP 500, the harness's 600-second execution ceiling, and a model response stream ending without a finish reason at roughly 92k tokens. The harness ceiling is configurable and was raised; the rest is the model backing the agent, and this harness offers exactly one. Each attempt is recorded rather than hidden, and the current fixture is the trace of the last one.

So the chain is real up to the gate, the gate is real and proven, and the stages after it are drawn but unproven on live data. That distinction is stated here rather than smoothed over, for the same reason the agent is required to state it.
