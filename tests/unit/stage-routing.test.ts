import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  applyEvent,
  emptyTimeline,
  findStageMarker,
  stripStageMarkers,
  type TimelineState,
} from "@/lib/timeline";

/**
 * Replays a recorded case. Every assertion here is about what a real harness
 * actually put on the wire, not about what the SDK types allow — the five dead
 * stages shipped because the whole suite modelled a harness nobody had seen.
 *
 * The recording is one real run against a live harness, investigating a real
 * issue in this repository. The model's response stream died at roughly 92k
 * tokens, so the agent never left stage 1 and never requested a write: the
 * recording covers the opening of the protocol and contains no approval pause.
 * Stages it never reached are asserted absent rather than imagined.
 *
 * Streaming fragments are removed. Every marker and every tool call survives on
 * the assembled messages, and delta merging is covered directly elsewhere, so
 * keeping 11,347 fragments would have added a megabyte and nothing else.
 */
const recorded = readFileSync("tests/fixtures/full-case.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { type: string })
  .filter((event) => event.type !== "case.started") as TrueForgeApi.TurnStreamingEvent[];

function replay(): TimelineState {
  let state = emptyTimeline();
  for (const event of recorded) {
    state = applyEvent(state, event);
  }
  return state;
}

describe("findStageMarker", () => {
  it("accepts the separators the model actually produced", () => {
    // The same instructions produced a colon in one run and an em dash in the
    // next, which is why the skill now mandates a literal form and this stays
    // tolerant of both.
    expect(findStageMarker("Beginning **Stage 1: Evidence**")).toBe("Evidence");
    expect(findStageMarker("Beginning **Stage 1 — Evidence**")).toBe("Evidence");
  });

  it("takes the last marker in a message, so a stage change wins", () => {
    expect(findStageMarker("**Stage 2: Hypothesis** … now **Stage 3: Reproduction**")).toBe(
      "Reproduction",
    );
  });

  it("trusts the name over the number when they disagree", () => {
    expect(findStageMarker("**Stage 9: Diagnosis**")).toBe("Diagnosis");
  });

  it("finds nothing in ordinary prose", () => {
    expect(findStageMarker("Stage one is done, moving on.")).toBeNull();
    expect(findStageMarker("")).toBeNull();
  });
});

describe("stripStageMarkers", () => {
  it("keeps the marker out of the text the reader sees", () => {
    // The stage it names is already the heading the text sits under.
    expect(stripStageMarkers("**Stage 1: Evidence** reading the issue.")).toBe(
      "reading the issue.",
    );
  });

  it("leaves prose alone", () => {
    expect(stripStageMarkers("No markers here.")).toBe("No markers here.");
  });
});

describe("the recorded case", () => {
  it("shows no raw stage markers on screen", () => {
    const staged = replay().entries.filter((entry) => entry.kind === "message");

    expect(staged.some((entry) => /\*\*Stage/.test(entry.text))).toBe(false);
  });

  it("fills Evidence with the work the agent actually did there", () => {
    const evidence = replay().entries.filter((entry) => entry.stage === "Evidence");

    expect(evidence.length).toBeGreaterThan(0);
    const tools = evidence.filter((entry) => entry.kind === "tool").map((entry) => entry.title);
    expect(tools).toContain("issue_read on github");
    expect(tools).toContain("get_file_contents on github");
    expect(tools).toContain("list_branches on github");
  });

  it("names tools rather than event types", () => {
    const staged = replay().entries.filter((entry) => entry.stage !== null);

    // The old UI rendered event.type into the stage, so a reader saw
    // "sandbox.created" where the work should have been.
    expect(staged.some((entry) => entry.title === "sandbox.created")).toBe(false);
    expect(staged.some((entry) => entry.title === "model.message")).toBe(false);
  });

  it("carries the agent's own reason for each sandbox command", () => {
    const detailed = replay()
      .entries.filter((entry) => entry.kind === "tool" && entry.title === "exec")
      .map((entry) => entry.detail ?? "");

    expect(detailed.length).toBeGreaterThan(0);
    expect(detailed.some((detail) => /clone/i.test(detail))).toBe(true);
  });

  it("settles a tool call when its response arrives", () => {
    const tools = replay().entries.filter((entry) => entry.kind === "tool");

    // The response names no tool, only the call it answers; settling proves the
    // join back to the requesting message works.
    expect(tools.some((entry) => entry.settled)).toBe(true);
  });

  it("accounts for every action, including work done before any stage", () => {
    const state = replay();

    // The agent's first act is a sandbox command, before it has announced a
    // stage. It has no heading to sit under, so the raw log has to carry it:
    // an empty stage is honest, an action shown nowhere is not.
    const unstaged = state.entries.filter((entry) => entry.stage === null);
    const orphanTools = unstaged.filter((entry) => entry.kind === "tool");
    expect(orphanTools.length).toBeGreaterThan(0);

    const accountedFor = state.entries.filter(
      (entry) => entry.stage !== null || entry.kind !== "message",
    );
    const everyTool = state.entries.filter((entry) => entry.kind === "tool");
    expect(everyTool.every((tool) => accountedFor.includes(tool))).toBe(true);
  });

  it("ignores stage markers that appear in tool output", () => {
    const state = replay();

    // The agent reads SKILL.md on every run, and SKILL.md contains a literal
    // `**Stage 1: Evidence**` as the mandated example; this recording also has
    // it reading this very file, whose fixtures name stages 2, 3 and 9. A
    // cursor that scanned tool responses would teleport between stages by
    // reading about them.
    expect(state.stage).toBe("Evidence");
    expect(state.entries.some((entry) => entry.stage === "Hypothesis")).toBe(false);
    expect(state.entries.some((entry) => entry.stage === "Diagnosis")).toBe(false);
  });

  it("keeps sandbox.created off Reproduction", () => {
    const state = replay();
    const reproduction = state.entries.filter((entry) => entry.stage === "Reproduction");

    // It fires the first time the agent runs anything at all — here, to read
    // the skill file while still on stage 1. Treating it as Reproduction
    // reported a reproduction that never happened.
    expect(reproduction).toHaveLength(0);
    expect(state.entries.some((entry) => entry.title === "sandbox.created")).toBe(true);
  });

  it("leaves the stages this run never reached empty", () => {
    const state = replay();

    for (const stage of ["Hypothesis", "Patch", "Verification", "Approval"] as const) {
      expect(state.entries.filter((entry) => entry.stage === stage)).toHaveLength(0);
    }
    expect(state.stage).toBe("Evidence");
  });
});
