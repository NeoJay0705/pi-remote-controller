import { describe, expect, it } from "vitest";
import type { RuntimeSession } from "../../src/shared/contracts.js";
import {
  boundedReceiptHistory,
  canReleaseRuntime,
  isUnresolvedRelease,
  mergeReceipt,
  releaseReason,
  runtimeName,
} from "../../src/web/rpc-management.js";

const runtime: RuntimeSession = {
  id: "controller-session-1",
  nameInfo: { status: "named", name: "Example" },
  cwd: "/synthetic/project",
  runtimeState: "idle",
  releaseEligible: true,
};
const fresh = {
  loaded: true,
  online: true,
  updatedAt: 10_000,
  now: 10_001,
  pending: false,
};

describe("RPC management safety helpers", () => {
  it("permits only fresh, online, idle, eligible and unblocked runtimes", () => {
    expect(canReleaseRuntime(runtime, fresh)).toBe(true);
    for (const change of [
      { loaded: false },
      { online: false },
      { updatedAt: 0, now: 15_001 },
      { pending: true },
    ])
      expect(canReleaseRuntime(runtime, { ...fresh, ...change })).toBe(false);
    expect(
      canReleaseRuntime({ ...runtime, runtimeState: "running" }, fresh),
    ).toBe(false);
    expect(
      canReleaseRuntime({ ...runtime, releaseEligible: false }, fresh),
    ).toBe(false);
  });

  it("shows truthful identity fallbacks and localized blocked reasons", () => {
    expect(runtimeName(runtime)).toBe("Example");
    expect(runtimeName({ ...runtime, nameInfo: { status: "error" } })).toBe(
      "Session 名稱不可用",
    );
    expect(runtimeName({ ...runtime, nameInfo: { status: "unnamed" } })).toBe(
      "未命名 Session",
    );
    expect(releaseReason("operation_in_flight")).toContain("操作正在處理");
    expect(releaseReason("unknown_reason")).toContain("無法安全釋放");
  });

  it("retains every unresolved release and the newest 30 ordinary receipts", () => {
    const receipts = Array.from({ length: 35 }, (_, index) => ({
      operationId: `ordinary-${index}`,
      sessionId: `session-${index}`,
      kind: "prompt" as const,
      status: index === 0 ? "ACCEPTED" : "DISPATCHED",
    }));
    const releases = [
      {
        operationId: "pending-release",
        sessionId: "released-id",
        kind: "release" as const,
        status: "DISPATCHED",
      },
      {
        operationId: "accepted-without-result",
        sessionId: "another-id",
        kind: "release" as const,
        status: "ACCEPTED",
      },
    ];
    const history = boundedReceiptHistory([...releases, ...receipts]);
    expect(history).toContainEqual(releases[0]);
    expect(history).toContainEqual(releases[1]);
    const ordinary = history.filter((receipt) => receipt.kind !== "release");
    expect(ordinary).toHaveLength(30);
    expect(ordinary.map(({ operationId }) => operationId)).toEqual(
      receipts.slice(0, 30).map(({ operationId }) => operationId),
    );
  });

  it("keeps newly dispatched and unknown ordinary intents in history", () => {
    const dispatched = {
      operationId: "new-prompt",
      sessionId: runtime.id,
      kind: "prompt" as const,
      status: "DISPATCHED",
    };
    const unknown = {
      ...dispatched,
      operationId: "unknown-prompt",
      status: "UNKNOWN",
    };
    expect(mergeReceipt([], dispatched)).toContainEqual(dispatched);
    expect(boundedReceiptHistory([unknown])).toContainEqual(unknown);
  });

  it("preserves result on receipt lookup and does not downgrade a terminal receipt", () => {
    const terminal = {
      operationId: "op",
      sessionId: runtime.id,
      kind: "release" as const,
      status: "ACCEPTED",
      result: { status: "released" },
    };
    const merged = mergeReceipt([terminal], {
      ...terminal,
      status: "DISPATCHED",
      result: undefined,
    });
    expect(merged[0]).toEqual(terminal);
  });

  it("keeps every release receipt locked unless rejection or confirmed released result", () => {
    const base = {
      operationId: "op",
      sessionId: runtime.id,
      kind: "release" as const,
      status: "DISPATCHED",
    };
    expect(isUnresolvedRelease(base)).toBe(true);
    expect(isUnresolvedRelease({ ...base, status: "UNKNOWN" })).toBe(true);
    expect(isUnresolvedRelease({ ...base, status: "REJECTED" })).toBe(false);
    expect(
      isUnresolvedRelease({
        ...base,
        status: "ACCEPTED",
        result: { status: "rejected" },
      }),
    ).toBe(true);
    expect(
      isUnresolvedRelease({
        ...base,
        status: "ACCEPTED",
        result: { status: "released" },
      }),
    ).toBe(false);
    expect(mergeReceipt([base], { ...base, status: "UNKNOWN" })).toHaveLength(
      1,
    );
  });
});
