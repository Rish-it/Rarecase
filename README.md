# Rarecase

> One GitHub issue in. An inspectable chain out. Nothing written without a human.

Rarecase is an evidence-first debugging agent. It reads an open issue and the repository it belongs to, reproduces the failure inside a sandbox, explains the mechanism, prepares the smallest defensible patch, proves it with a test that failed before and passes after — and then stops, because the next step writes to GitHub and that decision is not the agent's to make.

Investigation is autonomous. Mutation is not.

## The approval gate

Every external write pauses. The interface names the exact call the agent wants to make — the tool, the server it reaches, the arguments it will send — and waits for Allow or Deny. A denial ends the case: the agent records it and stops, rather than retrying or reaching the same effect with a different tool.

This is the part worth looking at. An agent that reads and reasons is common; an agent whose every irreversible act is a decision a human made on the record is not.

## The protocol

The chain has eight stages, defined in [`skills/rarecase-debugging/SKILL.md`](skills/rarecase-debugging/SKILL.md) and loaded by the agent at the start of every case:

`evidence → hypothesis → reproduction → diagnosis → patch → verification → approval → receipt`

Three rules do most of the work. Every claim carries a citation, or it is labelled a hypothesis. No product code is edited until a test fails for the reported reason. A fix counts as verified only when the _same unmodified test_ fails on the base revision and passes on the patched tree — editing the test to fit the patch voids the proof and must be reported as a failure.

Stopping with an honest account of a missing link is a successful outcome. Fabricating the missing link is the failure the protocol exists to prevent.

## Architecture

The Next.js app is the only process that talks to the harness; it holds no model, GitHub, or sandbox credential of its own.

| Layer                 | Choice                                                      |
| --------------------- | ----------------------------------------------------------- |
| Product app           | Next.js App Router, React 19, TypeScript strict, Tailwind 4 |
| Input validation      | Zod at every trust boundary, including the environment      |
| Agent runtime         | TrueForge server and `@truefoundry/trueforge-sdk`           |
| Reusable instructions | Git-backed `skills/rarecase-debugging/SKILL.md`             |
| External systems      | GitHub MCP, with `@write` and `@destructive` gated          |
| Isolated execution    | TrueForge sandbox-as-tool                                   |
| Delegation            | TrueForge dynamic subagents                                 |
| Transport             | Server-sent events, one frame per harness event             |
| Tests                 | Vitest unit tests, Playwright end-to-end                    |
| Local runtime         | Node.js 22.14+, pnpm, TrueForge in SQLite mode              |

Streaming deserves a note. A single turn emits well over a thousand `model.message.delta` fragments, so the transport merges them into their base message rather than re-serialising a growing message per fragment. A turn that pauses for a human still reports `turn.done`, listing the decision it is waiting on — treating that as the end of the case would retire the approval card in the same render that raised it.

## Hackathon proof

| Required proof                     | Status  | Where                                                                         |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------- |
| Use TrueForge as a core dependency | Proven  | Sessions, turns, streamed events, and approvals all route through the harness |
| Reach a real tool through MCP      | Proven  | GitHub reads and writes, with writes gated behind `@write`                    |
| Pause before a sensitive action    | Proven  | The approval card, driven by live `tool.approval_required` events             |
| Use reusable instructions          | Proven  | The saved agent loads the repository-owned debugging skill                    |
| Run generated code in a sandbox    | Partial | The sandbox is enabled and provisions per case; test execution is in progress |
| Delegate meaningful work           | Partial | Investigator, Reproducer, and Verifier are defined; visible output is pending |
| Carry context across sessions      | Planned | Sessions persist in the harness; the UI does not yet restore one              |
| Demonstrate code quality           | Ongoing | `pnpm verify` gates every branch; reviews run on development pull requests    |

## Getting started

Requires Node.js 22.14 or newer, pnpm, and a TrueForge harness.

```bash
npx @truefoundry/trueforge      # harness on http://localhost:8790
pnpm install
cp .env.example .env.local      # harness location only
pnpm dev                        # http://localhost:3000
```

Quality checks, in increasing strength:

```bash
pnpm format:check   # Prettier
pnpm lint           # ESLint
pnpm typecheck      # next typegen, then tsc --noEmit in strict mode
pnpm test           # Vitest unit tests
pnpm verify         # all four, in order
pnpm build          # Next.js production build
pnpm test:e2e       # Playwright, mobile Chromium at 390x844
```

Playwright needs its browser once: `pnpm exec playwright install chromium`.

The end-to-end suite drives a real case against a live harness and costs several minutes of model work per run. It skips only when nothing answers at the harness address; a harness that answers but misbehaves fails loudly.

## Status

Working today: the harness connection, the session transport, the case API, the approval gate end to end, and a denial that leaves GitHub untouched — confirmed against GitHub rather than against local UI state.

Known gap: of the eight protocol stages, only Reproduction, Approval, and Receipt currently receive events. The other five render empty because `mapEventToStage` has no rule for them yet. The chain is enforced by the agent and visible in the raw event log, but it is not yet fully drawn in the case file. That is the next change.
