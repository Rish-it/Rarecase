# Rarecase

> Turn elusive production bugs into reproducible tests, verified fixes, and human-approved pull requests.

Rarecase is an evidence-first debugging agent for web teams and the first vertical of a verified commit layer for coding agents. It starts from a real production issue, reconstructs the failing environment in an isolated browser sandbox, proves the failure, prepares the smallest defensible fix, proves the fix, and pauses before it writes to GitHub.

## The demo in one minute

1. Rarecase reads a mobile checkout failure from Sentry through MCP.
2. It inspects the affected public repository through GitHub MCP.
3. A saved TrueForge agent loads the Rarecase debugging skill and delegates bounded work to Investigator, Reproducer, and Verifier subagents.
4. Playwright reproduces the bug inside a Daytona sandbox and captures a trace.
5. The generated regression test fails before the patch and passes after it.
6. A human reviews the staged commit and approves or denies the exact GitHub write.
7. After approval, Rarecase opens a pull request for Qodo to review and records the observed outcome in a commit receipt.

The interface presents this as a visual case file: evidence, browser filmstrip, console and network events, root cause, code diff, verification, and an explicit approval checkpoint. Chat is secondary.

## Product contract

Rarecase may investigate autonomously. It may not claim a fix without a failing-then-passing test, and it may not mutate a repository without human approval. The hackathon build never merges or deploys code. Every completed case leaves a receipt connecting the source evidence, generated test, proposed diff, approval decision, resulting pull request, and independent review.

## Locked MVP

The first end-to-end case is intentionally narrow and reliable:

- one owned public monorepo;
- one real Sentry issue emitted by an intentionally faulty demo checkout;
- one Chromium mobile profile at `390 x 844` under slow network conditions;
- one defect: a double tap can submit checkout twice;
- one saved agent, one debugging skill, and three bounded subagent roles;
- one generated Playwright regression test and one minimal patch;
- one approval-gated pull request and commit receipt; and
- one Qodo review surfaced in the case file.

## Stack at a glance

| Layer                 | Choice                                                               |
| --------------------- | -------------------------------------------------------------------- |
| Product app           | Next.js App Router, React, TypeScript                                |
| Styling and motion    | Tailwind CSS, Radix primitives, Motion                               |
| Agent runtime         | TrueForge server and `@truefoundry/trueforge-sdk`                    |
| Reusable instructions | Git-backed Rarecase debugging `SKILL.md`                             |
| External systems      | Sentry MCP and GitHub MCP                                            |
| Isolated execution    | Daytona through TrueForge's sandbox-as-tool                          |
| Browser evidence      | Playwright tests and traces                                          |
| Error source          | Sentry SDK and Session Replay on the demo route                      |
| Code review           | Qodo throughout development and on the generated GitHub pull request |
| Local runtime         | Node.js 22.13+, pnpm, TrueForge SQLite mode                          |
| Deployment            | Vercel for the web app; TrueForge local for the judged demo          |

## Hackathon proof

| Required proof                     | Rarecase makes it visible                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Reach a real tool through MCP      | Sentry issue reads and GitHub repository reads/writes appear in the TrueForge activity rail.                                |
| Run generated code in a sandbox    | The generated Playwright regression test executes in a Daytona sandbox provisioned by TrueForge.                            |
| Delegate meaningful work           | Investigator, Reproducer, and Verifier run as bounded dynamic TrueForge subagents with visible outputs.                     |
| Use reusable instructions          | The saved agent loads a repository-owned Rarecase debugging skill that defines the evidence and verification protocol.      |
| Carry context across sessions      | The case is backed by a persistent TrueForge session and restores its stage, artifacts, and pending approval after refresh. |
| Pause before a sensitive action    | TrueForge pauses before every GitHub write and shows the exact action for Allow/Deny.                                       |
| Use TrueForge as a core dependency | Sessions, tools, sandbox lifecycle, streamed events, approval, and recovery all depend on the harness.                      |
| Demonstrate code quality           | Qodo reviews development pull requests throughout the build and independently reviews the agent-generated pull request.     |

## Current status

Project definition is locked and ready for implementation. The first vertical slice is a real Sentry event, a saved TrueForge agent and skill, a persistent session, and a visible case timeline before autonomous patching is added.
