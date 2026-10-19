import { describe, expect, it } from "vitest";
import { canSubmitMessage } from "../../src/web/session-ui.js";

const base = {
  draft: " message ",
  connected: true,
  online: true,
  busy: false,
  hasSnapshot: true,
};

describe("message operation eligibility", () => {
  const states = [
    "released",
    "starting",
    "idle",
    "running",
    "stopping",
    "releasing",
    "blocked",
  ] as const;
  const kinds = ["prompt", "steer", "follow_up"] as const;

  it("checks every message kind against every runtime state", () => {
    for (const kind of kinds)
      for (const runtimeState of states)
        expect(
          canSubmitMessage({ ...base, kind, runtimeState }),
          `${kind} in ${runtimeState}`,
        ).toBe(
          (kind === "prompt" &&
            (runtimeState === "idle" || runtimeState === "released")) ||
            (kind !== "prompt" && runtimeState === "running"),
        );
  });

  it("rejects missing snapshots, blank drafts, offline, disconnected, and busy", () => {
    for (const kind of kinds) {
      const valid = {
        ...base,
        kind,
        runtimeState:
          kind === "prompt" ? ("idle" as const) : ("running" as const),
      };
      expect(canSubmitMessage(valid), `${kind} baseline`).toBe(true);
      for (const blocked of [
        { hasSnapshot: false },
        { draft: "  " },
        { online: false },
        { connected: false },
        { busy: true },
        { runtimeState: undefined },
      ])
        expect(
          canSubmitMessage({ ...valid, ...blocked }),
          `${kind} blocked`,
        ).toBe(false);
    }
  });
});
