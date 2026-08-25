---
name: rarecase-debugging
description: >
  The Rarecase investigation protocol: turn a production issue into evidence, a
  deterministic browser reproduction, a root cause, a minimal patch, a
  failing-then-passing regression test, and an approval-gated pull request.
  Load this before starting or resuming any case. It defines what counts as
  evidence, when reproduction is complete, what may be claimed as verified, and
  the conditions under which the investigation must stop instead of patching.
license: MIT
---

# Rarecase debugging protocol

You investigate one production issue at a time and produce an inspectable chain:

`evidence -> reproduction -> diagnosis -> patch -> verification -> approval -> receipt`

Investigation is autonomous. Mutation of an external system is not. You may read
freely and execute freely inside the sandbox; you may not write to GitHub until a
human approves the exact action.

## Non-negotiable rules

1. **Evidence before inference.** Every claim cites an issue event, a repository
   location with a line number, a sandbox observation, or a test result. A claim
   you cannot cite is a hypothesis, and you label it as one.
2. **Reproduce before patch.** You do not edit product code until a test fails
   for the reported reason. If reproduction fails, stop and report what evidence
   is missing. A plausible fix without a reproduction is a guess.
3. **Verify, do not claim.** A fix is verified only when the _same unmodified
   test_ fails on the base revision and passes on the patched tree. Editing the
   test to fit the patch voids the proof and must be reported as a failure.
4. **Smallest defensible change.** Fix the shared root cause, not the reported
   symptom. Do not reformat, rename, upgrade, or tidy anything the fix does not
   require.
5. **Never mutate without approval.** Branch creation, file writes, comments,
   and pull requests are human decisions. Never work around a pause, retry a
   denied call, or pick a different tool to achieve a denied effect.
6. **Say what is uncertain.** Report partial reproduction, a flaky run, or an
   unverified assumption plainly. An honest incomplete case is worth more than a
   confident wrong one.

## Stages

### 1. Evidence

Read the issue through the Sentry tools: error type and message, stack frames,
release, environment, device and viewport, breadcrumbs, and the replay context
when exposed. Then read the repository through the GitHub tools to locate the
code named by the stack frames.

Record the base revision SHA now. Every later comparison refers to it.

Done when you can state the symptom, the environment it occurred in, and the
files plausibly responsible, each with a citation.

### 2. Hypothesis

State one falsifiable hypothesis in the form:

> Under `<environment and timing conditions>`, `<action>` causes `<observable
failure>` because `<mechanism>` at `<file:line>`.

If the evidence supports several mechanisms, name the one you will test first
and what observation would refute it. A hypothesis that no observation could
refute is not usable — refine it.

### 3. Reproduction

Work in the sandbox. Clone the repository at the recorded base SHA, install the
locked dependencies, run the app, and write the smallest browser test that
demonstrates the symptom.

The reproduction must be deterministic by construction: set the viewport, the
network conditions, and the interaction explicitly. Never make a test pass or
fail by waiting a fixed number of milliseconds and hoping, and never rerun a
test until it produces the result you want.

Capture and keep: the test source, the failure output, a trace, a screenshot,
the console excerpt, and the count of the requests that matter.

Done when the test fails on the base revision for the same reason production
failed. If it does not, stop here and report the gap. Do not proceed to patch.

### 4. Diagnosis

Explain the mechanism in a few sentences, linked to a specific file and line and
to the runtime observations from the reproduction. State why the failure is
intermittent in production if it is.

### 5. Patch

Apply the minimal change to the working tree in the sandbox. Keep the regression
test with the change. Do not touch unrelated code.

### 6. Verification

Run the same unmodified test against the patched tree. Capture the same
artifacts as the base run so the before and after are comparable.

Report the transition explicitly: which test, which base SHA, what changed in
the observable evidence. If the test still fails, the patch is wrong — return to
diagnosis rather than adjusting the test.

### 7. Staged intent and approval

Before requesting any write, state the exact intent: base SHA, branch name, the
list of changed files, and the artifact that proves the fix. Then request the
write.

When the pause arrives, it belongs to the human. If denied, leave the external
system untouched, record the denial, and stop.

### 8. Receipt

After an approved write, read GitHub again. Compare the approved intent with the
observed state — pull request URL, head SHA, changed files — and report whether
they match. A successful tool response is evidence that a call returned, not
that the repository contains what you intended.

## Stop conditions

Stop and report instead of continuing when:

- the symptom cannot be reproduced after a genuine attempt;
- reproduction requires data, credentials, or an environment you do not have;
- the fix would touch code outside the area the evidence implicates;
- the test only passes intermittently on either revision; or
- a required approval is denied.

Stopping with an honest account of the missing link is a successful outcome of
this protocol. Fabricating the missing link is the one failure it exists to
prevent.

## Delegation

Delegate bounded work and require citations back:

| Subagent     | Owns       | Must return                                                                     |
| ------------ | ---------- | ------------------------------------------------------------------------------- |
| Investigator | Stages 1–2 | Evidence citations, affected files, one falsifiable hypothesis                  |
| Reproducer   | Stage 3    | The failing test, its output, trace, screenshot, console, request count         |
| Verifier     | Stage 6    | An independent red-to-green verdict, and a rejection if the proof is incomplete |

You own orchestration, the patch, the staged intent, the approval request, and
the receipt. Reject any subagent summary that asserts a result without the
artifact that supports it, and say so rather than accepting it quietly.
